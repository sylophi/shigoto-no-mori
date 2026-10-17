// Durable proof for what the host says is under way (Scripts.busy,
// host/lib/Scripts.ts) and the words a quit and a peer's data-folder
// move put on it (shared/busy.ts), over a REAL git repository, the
// engine's create and delete, and a REAL login shell.
//
// Asserts:
//   - a create's setup script reads as one script running, not as a
//     worktree being removed,
//   - one delete, held at its status check by an fsmonitor hook, reads
//     as one worktree being removed, not two, and its own engine change
//     is not counted again as a change,
//   - any other engine change counts while it runs and not after, and
//     reads as a change being made,
//   - a tombstone interrupted or dead leaves no mark behind: the
//     worktree can be deleted and run in again,
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
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { afterAll, beforeAll, it } from "vitest";
import type { Project } from "@shigomori/contracts/schemas";
import { runtimeHandlers } from "../host/ipc/modules/runtime.ts";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import { asChange } from "../host/lib/Engine.ts";
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
    const counted = await busy();
    assert.equal(counted.inflightDeletes, 1);
    assert.equal(counted.engineChanges, 0);
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

it("an engine change counts while it runs", async () => {
  const release = await runHost(Deferred.make<void>());
  const held = runHost(
    asChange(Deferred.await(release), { projectId: project.id }),
  );
  try {
    await waitFor(
      async () => (await busy()).engineChanges === 1,
      "the change to be counted",
    );
  } finally {
    await runHost(Deferred.succeed(release, undefined));
    await held;
  }
  assert.equal((await busy()).engineChanges, 0);
});

it("any other engine change reads as a change being made", () => {
  const one = {
    runningScripts: 0,
    inflightDeletes: 0,
    engineChanges: 1,
    busyTerminals: 0,
  };
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
    // The shell's own startup and prompt hooks read as busy for a
    // moment too, so the job says when it runs.
    const running = join(root, "job.running");
    await waitFor(
      async () => (await terminals((service) => service.busy)) === 0,
      "an idle prompt",
    );
    await terminals((service) =>
      service.write(terminalId, `touch '${running}'; sleep 30\r`),
    );
    await waitFor(
      async () =>
        existsSync(running) &&
        (await terminals((service) => service.busy)) === 1,
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

it("a tombstone interrupted or dead leaves no mark behind", async () => {
  const worktree = { id: "gone-wt", name: "gone", branch: "gone", path: root };
  const busyWords = "This worktree is already being removed.";
  await runHost(
    Effect.gen(function* () {
      const scripts = yield* Scripts.Scripts;
      const inside = yield* Deferred.make<void>();
      const interrupted = yield* Effect.forkChild(
        scripts.withDeleteInflight(
          worktree.id,
          busyWords,
          Deferred.succeed(inside, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          () => Effect.void,
        ),
      );
      yield* Deferred.await(inside);
      assert.equal((yield* scripts.busy).inflightDeletes, 1);
      yield* Fiber.interrupt(interrupted);
      assert.equal((yield* scripts.busy).inflightDeletes, 0);

      const died = yield* Effect.exit(
        scripts.withDeleteInflight(
          worktree.id,
          busyWords,
          Effect.die("the mutation died"),
          () => Effect.void,
        ),
      );
      assert.ok(Exit.isFailure(died) && Cause.hasDies(died.cause));
      assert.equal((yield* scripts.busy).inflightDeletes, 0);

      // Neither a delete nor a run is refused there now.
      yield* scripts.assertWorktreeMutable(worktree.id, busyWords);
      yield* scripts.start({
        command: "exit 0",
        slot: { kind: "package", name: "after" },
        worktree,
        project: { id: project.id, path: repo, name: "repo" },
        notify: () => {},
      });
    }),
  );
});
