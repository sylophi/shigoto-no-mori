// Durable proof for what the host says is under way (Scripts.busy,
// host/lib/Scripts.ts) and the words a quit and a peer's data-folder
// move put on it (shared/busy.ts), over a REAL git repository, the
// engine's create and delete, and a REAL login shell.
//
// Asserts:
//   - a create's setup script reads as one script running, not as a
//     worktree being removed,
//   - one delete, held at its status check by an fsmonitor hook, reads
//     as one worktree being removed, not two,
//   - any other engine change reads as a change being made,
//   - a peer's data-folder move is refused over a terminal running a
//     job, in the words a quit would ask with.
//
// Run: pnpm test busy.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, it } from "vitest";
import type { Project } from "@shigomori/contracts/schemas";
import { runtimeHandlers } from "../host/ipc/modules/runtime.ts";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import * as Terminals from "../host/lib/terminals/Terminals.ts";
import { busyDetail, busyRemoteRefusal } from "../shared/busy.ts";
import type { HandlerContext } from "../shared/ipc/transport.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import {
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";

// The host's git runs in this process: a commit hook's GIT_* would point
// it at the repository being committed.
scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let root: string;
let repo: string;
let project: Project;

beforeAll(async () => {
  initDataDirAt(engineDataDir);
  root = tempDir("sm-busy-", track);
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
  project = await runHost(addProject(repo));
});
afterAll(teardown);

const busy = () =>
  runHost(Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy));
const quiet = {
  notifyPhase: () => {},
  notifyCarryOverComplete: () => {},
  notifyScript: () => {},
};
const here: HandlerContext = {
  notifier: () => () => {},
  connection: new AbortController().signal,
};

it("a create's setup script reads as a script running", async () => {
  const held = join(root, "setup.held");
  const started = join(root, "setup.started");
  writeFileSync(held, "");
  await runHost(
    Ops.writeProjectConfig(project.id, {
      defaultBranch: "main",
      scripts: {
        setup: `touch '${started}'; while [ -f '${held}' ]; do sleep 0.05; done`,
      },
    }),
  );
  await runHost(Ops.createWorktree(project, { worktreeName: "fox" }, quiet));
  try {
    await waitFor(() => existsSync(started), "the setup script to start");
    assert.equal(
      busyDetail(await busy(), "quit"),
      "1 script is still running. Quitting now will stop it.",
    );
  } finally {
    rmSync(held);
  }
  await waitFor(
    async () => busyDetail(await busy(), "quit") === null,
    "the create to end",
  );
});

it("one delete reads as one worktree being removed", async () => {
  await runHost(Ops.writeProjectConfig(project.id, { defaultBranch: "main" }));
  const { worktree } = await runHost(
    Ops.createWorktree(project, { worktreeName: "otter" }, quiet, {
      resolveOn: "exit",
    }),
  );
  // Holds a `git status` while `slow` exists, then lets git scan the
  // tree itself.
  const slow = join(root, "status.slow");
  const holding = join(root, "status.holding");
  const hook = join(root, "fsmonitor");
  writeFileSync(
    hook,
    `#!/bin/sh\n[ -f '${slow}' ] || exit 1\ntouch '${holding}'\nwhile [ -f '${slow}' ]; do sleep 0.05; done\nexit 1\n`,
  );
  chmodSync(hook, 0o755);
  git(repo, "config", "core.fsmonitor", hook);
  writeFileSync(slow, "");
  const deleting = runHost(
    worktreesHandlers.delete(
      {
        projectId: project.id,
        worktreeId: worktree.id,
        force: false,
        skipCleanup: false,
        refuseRunningScripts: false,
      },
      here,
    ),
  );
  try {
    await waitFor(() => existsSync(holding), "the delete's status check");
    assert.equal(
      busyDetail(await busy(), "quit"),
      "1 worktree is being removed. Quitting now will interrupt cleanup and may leave files behind.",
    );
  } finally {
    rmSync(slow);
    await deleting;
    git(repo, "config", "--unset", "core.fsmonitor");
  }
  assert.equal(busyDetail(await busy(), "quit"), null);
});

it("any other engine change reads as a change being made", () => {
  const one = { runningScripts: 0, inflightDeletes: 0, engineChanges: 1 };
  assert.equal(
    busyDetail(one, "quit"),
    "1 change is still being made. Quitting now will interrupt it.",
  );
  assert.equal(
    busyRemoteRefusal({ ...one, engineChanges: 2 }, "move"),
    "2 changes are still being made there. Wait for them to finish before moving the data folder.",
  );
});

const terminals = <A, E>(
  body: (service: Terminals.Terminals["Service"]) => Effect.Effect<A, E>,
) => runHost(Effect.flatMap(Terminals.Terminals, body));

it("a peer's data-folder move is refused over a busy terminal", async () => {
  const { terminalId } = await terminals((service) =>
    service.open({ owner: { kind: "device" } }),
  );
  try {
    await terminals((service) => service.write(terminalId, "sleep 30\r"));
    await waitFor(
      async () => (await terminals((service) => service.busy)) === 1,
      "the job to start",
    );
    assert.equal(
      busyDetail(await busy(), "quit"),
      "1 terminal is still running. Quitting now will stop it.",
    );
    // A folder the move would refuse anyway, should the busy check let
    // it through.
    await assert.rejects(
      runHost(
        runtimeHandlers.moveDataDir(
          { parentDir: "not/absolute" },
          { ...here, callerDeviceId: "peer" },
        ),
      ),
      {
        message:
          "1 terminal is still running there. Stop it before moving the data folder.",
      },
    );
  } finally {
    await terminals((service) => service.close(terminalId));
  }
});
