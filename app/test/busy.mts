// Durable proof for what the host says is under way (Scripts.busy,
// host/lib/Scripts.ts) and the words a quit and a peer's data-folder
// move put on it (shared/busy.ts), over a REAL git repository, the
// engine's create and delete, and a REAL login shell.
//
// Asserts:
//   - a create's setup reads as a script running and a new worktree
//     being made, not as a worktree being removed,
//   - one delete, held at its status check by an fsmonitor hook, reads
//     as one worktree being removed, not two, and its own engine change
//     is not counted again as a change,
//   - any other engine change counts while it runs and not after, and
//     reads as a change being made,
//   - a tombstone interrupted or dead leaves no mark behind: the
//     worktree can be deleted and run in again,
//   - a peer's data-folder move is refused over a terminal running a
//     job, in the words a quit would ask with,
//   - a move under its mark reads as a worktree being moved, not
//     removed, and refuses a run there in those words,
//   - an auto-pull's fast-forward, which holds the data-folder lock,
//     counts as a change while it runs.
//
// Run: pnpm test busy.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, it } from "vitest";
import type { Project } from "@shigomori/contracts/schemas";
import { runtimeHandlers } from "../host/ipc/modules/runtime.ts";
import { worktreesHandlers } from "../host/ipc/modules/worktrees.ts";
import * as BackgroundFetch from "../host/lib/BackgroundFetch.ts";
import { asChange, changing } from "../host/lib/Engine.ts";
import { changeKindOf } from "../host/socket/changeKinds.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import { autoPullWorktree } from "../host/lib/worktrees/autoPullSweep.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import * as HostWorktrees from "../host/lib/Worktrees.ts";
import * as Terminals from "../host/lib/terminals/Terminals.ts";
import {
  type BusyOperations,
  busyDetail,
  busyRefusal,
  busyRemoteRefusal,
} from "../shared/busy.ts";
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
  await runHost(
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.create({ projectId: project.id, worktreeName: "fox" }, quiet),
    ),
  );
  try {
    await waitFor(() => existsSync(started), "the setup script to start");
    assert.equal(
      busyDetail(await busy(), "quit"),
      "1 script is still running and a new worktree is still being made. Quitting now will interrupt them.",
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
    Effect.flatMap(HostWorktrees.Worktrees, (worktrees) =>
      worktrees.create(
        { projectId: project.id, worktreeName: "otter" },
        quiet,
        {
          resolveOn: "exit",
        },
      ),
    ),
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
    assert.deepEqual(counted.engineChanges, []);
    assert.equal(
      busyDetail(await busy(), "quit"),
      "A worktree is still being removed. Quitting now will interrupt cleanup and may leave files behind.",
    );
  } finally {
    rmSync(slow);
    await deleting;
    git(repo, "config", "--unset", "core.fsmonitor");
  }
  assert.equal(busyDetail(await busy(), "quit"), null);
});

it("git work a person started counts while it runs, and a write that names none doesn't", async () => {
  const release = await runHost(Deferred.make<void>());
  const pulling = runHost(
    asChange(
      Deferred.await(release),
      { projectId: project.id },
      changeKindOf("worktrees:pull"),
    ),
  );
  const writing = runHost(
    asChange(Deferred.await(release), { projectId: project.id }),
  );
  try {
    await waitFor(
      async () => (await busy()).engineChanges.length === 1,
      "the pull to be counted",
    );
    assert.equal(
      busyDetail(await busy(), "quit"),
      "A pull is still being made. Quitting now will interrupt it.",
    );
  } finally {
    await runHost(Deferred.succeed(release, undefined));
    await Promise.all([pulling, writing]);
  }
  assert.deepEqual((await busy()).engineChanges, []);
});

const busyWith = (...engineChanges: BusyOperations["engineChanges"]) => ({
  runningScripts: 0,
  inflightDeletes: 0,
  inflightMoves: 0,
  engineChanges,
  busyTerminals: 0,
});

it("the calls a person starts that run git past a moment are named, and a page's refresh as it opens isn't", () => {
  assert.deepEqual(
    Object.fromEntries(
      [
        "worktrees:switchToPrimaryAndDeleteBranch",
        "githubCli:resolvePullRequestCheckout",
        "worktrees:checkoutBranch",
        "worktrees:continueOperation",
        "worktrees:stashChanges",
        "worktrees:applyStash",
        "worktrees:restoreStash",
        "worktrees:pullAndPush",
        "sync:receiveBundle",
        "git:fetchProject",
        "git:refreshProject",
        "worktrees:setShelved",
      ].map((channel) => [channel, changeKindOf(channel) ?? null]),
    ),
    {
      "worktrees:switchToPrimaryAndDeleteBranch": "finish",
      "githubCli:resolvePullRequestCheckout": "fetch",
      "worktrees:checkoutBranch": "checkout",
      "worktrees:continueOperation": "commit",
      "worktrees:stashChanges": "stash",
      "worktrees:applyStash": "unstash",
      "worktrees:restoreStash": "unstash",
      "worktrees:pullAndPush": "pullAndPush",
      "sync:receiveBundle": null,
      "git:fetchProject": "fetch",
      "git:refreshProject": null,
      "worktrees:setShelved": null,
    },
  );
});

it("the words name the git work under way", () => {
  assert.equal(
    busyDetail(busyWith("commit"), "quit"),
    "A commit is still being made. Quitting now will interrupt it.",
  );
  assert.equal(
    busyDetail(busyWith("autoPull"), "restart"),
    "An auto-pull is still being made. Restarting now will interrupt it.",
  );
  assert.equal(
    busyDetail(busyWith("push", "push"), "quit"),
    "2 pushes are still being made. Quitting now will interrupt them.",
  );
  assert.equal(
    busyRemoteRefusal(busyWith("push", "pull", "pull"), "move"),
    "On that device, 2 pulls and a push are still being made. Wait for them to finish before moving the data folder.",
  );
  assert.equal(
    busyDetail(busyWith("pull", "fetch", "create"), "quit"),
    "3 operations (a pull, a fetch and a new worktree) are still being made. Quitting now will interrupt them.",
  );
  assert.equal(
    busyDetail(busyWith("pull", "push", "commit"), "quit"),
    "3 git operations (a pull, a push and a commit) are still being made. Quitting now will interrupt them.",
  );
  assert.equal(
    busyDetail(busyWith("land", "send", "finish", "pullRequest"), "quit"),
    "A branch is still being finished, a pull request is still being opened, a worktree is still being sent and a worktree is still arriving. Quitting now will interrupt them.",
  );
});

it("the words read cleanly however the kinds mix, on this screen and another's", () => {
  // A list in parentheses runs into no clause after it.
  assert.equal(
    busyDetail(busyWith("pull", "push", "autoPull", "send"), "quit"),
    "3 git operations (a pull, a push and an auto-pull) are still being made and a worktree is still being sent. Quitting now will interrupt them.",
  );
  // A pull and push is a pull and a push.
  assert.equal(
    busyDetail(busyWith("pull", "pullAndPush"), "quit"),
    "2 pulls and a push are still being made. Quitting now will interrupt them.",
  );
  // Another device's screen: "there" once, and a move between devices
  // in that device's terms.
  assert.equal(
    busyRemoteRefusal(busyWith("bring", "bring", "send"), "restart"),
    "On that device, a worktree is still being sent off and 2 worktrees are still being brought in. Wait for them to finish before restarting to update.",
  );
  assert.equal(
    busyRemoteRefusal(busyWith("pull", "push", "commit"), "quit"),
    "On that device, 3 git operations (a pull, a push and a commit) are still being made. Wait for them to finish before quitting.",
  );
});

it("every kind of work under way is named in one sentence", () => {
  const mixed = {
    ...busyWith("pull"),
    busyTerminals: 1,
    inflightDeletes: 1,
  };
  assert.equal(
    busyDetail(mixed, "quit"),
    "1 terminal is still running, a worktree is still being removed and a pull is still being made. Quitting now will interrupt them and may leave files behind.",
  );
  assert.equal(
    busyDetail({ ...busyWith("pull"), busyTerminals: 1 }, "restart"),
    "1 terminal is still running and a pull is still being made. Restarting now will interrupt them.",
  );
  assert.equal(
    busyRemoteRefusal(mixed, "quit"),
    "On that device, 1 terminal is still running, a worktree is still being removed and a pull is still being made. Stop or wait for them before quitting.",
  );
  assert.equal(
    busyRefusal(busyWith("move")),
    "A worktree is still being moved. Try again when it finishes.",
  );
});

it("the background's fetches and a page's refresh as it opens make no quit ask", async () => {
  // An origin whose upload-pack waits while `slow` exists, so a fetch
  // from it holds.
  const origin = join(root, "slow-origin.git");
  const slow = join(root, "fetch.slow");
  const holding = join(root, "fetch.holding");
  const uploadPack = join(root, "slow-upload-pack");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, "push", "-q", origin, "HEAD:main");
  writeFileSync(
    uploadPack,
    `#!/bin/sh
if [ -f '${slow}' ]; then touch '${holding}'; while [ -f '${slow}' ]; do sleep 0.05; done; fi
exec git-upload-pack "$@"
`,
  );
  chmodSync(uploadPack, 0o755);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "config", "remote.origin.uploadpack", uploadPack);
  writeFileSync(slow, "");
  try {
    await runHost(
      Effect.scoped(
        Effect.gen(function* () {
          // Its first pass fetches every project.
          const context = yield* Layer.build(
            BackgroundFetch.layer({
              broadcast: () => {},
              announceProjectChanged: () => {},
            }),
          );
          const fetches = Context.get(context, BackgroundFetch.BackgroundFetch);
          yield* Effect.promise(() =>
            waitFor(() => existsSync(holding), "the sweep's fetch"),
          );
          // A page's refresh as it opens joins the fetch under way.
          const inside = yield* Deferred.make<void>();
          const refreshing = yield* Effect.forkChild(
            changing(
              Effect.andThen(
                Deferred.succeed(inside, undefined),
                fetches.refreshProject(project.id, repo),
              ),
              { projectId: project.id },
              changeKindOf("git:refreshProject"),
            ),
          );
          yield* Deferred.await(inside);
          const counted = yield* Effect.flatMap(
            Scripts.Scripts,
            (scripts) => scripts.busy,
          );
          assert.equal(busyDetail(counted, "quit"), null);
          rmSync(slow);
          yield* Fiber.join(refreshing);
        }),
      ),
    );
  } finally {
    rmSync(slow, { force: true });
    git(repo, "remote", "remove", "origin");
  }
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
          "On that device, 1 terminal is still running. Stop it before moving the data folder.",
      },
    );
  } finally {
    await terminals((service) => service.close(terminalId));
  }
  // What was typed is in the run's history, not the developer's
  // (hostRuntime.mts), for the shells that keep one: zsh's, bash's.
  const histories = [
    join(process.env["ZDOTDIR"] ?? "", ".zsh_history"),
    process.env["HISTFILE"] ?? "",
  ];
  const shell = basename(process.env["SHELL"] ?? "");
  if (shell === "zsh" || shell === "bash") {
    await waitFor(
      () =>
        histories.some(
          (history) =>
            existsSync(history) &&
            readFileSync(history, "utf8").includes("job.running"),
        ),
      "the shell's history in the run",
    );
  }
});

it("a tombstone interrupted or dead leaves no mark behind", async () => {
  const worktree = { id: "gone-wt", name: "gone", branch: "gone", path: root };
  const mark = {
    kind: "remove",
    busy: "This worktree is already being removed.",
  } as const;
  await runHost(
    Effect.gen(function* () {
      const scripts = yield* Scripts.Scripts;
      const inside = yield* Deferred.make<void>();
      const interrupted = yield* Effect.forkChild(
        scripts.withDeleteInflight(
          worktree.id,
          mark,
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
          mark,
          Effect.die("the mutation died"),
          () => Effect.void,
        ),
      );
      assert.ok(Exit.isFailure(died) && Cause.hasDies(died.cause));
      assert.equal((yield* scripts.busy).inflightDeletes, 0);

      // Neither a delete nor a run is refused there now.
      yield* scripts.assertWorktreeMutable(worktree.id, mark.busy);
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

it("a move under its mark reads as a worktree being moved, and a run there is refused in those words", async () => {
  const worktree = {
    id: "moving-wt",
    name: "moving",
    branch: "moving",
    path: root,
  };
  await waitFor(
    async () => busyDetail(await busy(), "quit") === null,
    "the last proof's run to end",
  );
  await runHost(
    Effect.gen(function* () {
      const scripts = yield* Scripts.Scripts;
      const inside = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const moving = yield* Effect.forkChild(
        scripts.withDeleteInflight(
          worktree.id,
          { kind: "move", busy: "This worktree is already being moved." },
          Deferred.succeed(inside, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
          () => Effect.void,
        ),
      );
      yield* Deferred.await(inside);
      const counted = yield* scripts.busy;
      assert.equal(
        busyDetail(counted, "quit"),
        "A worktree is still being moved. Quitting now will interrupt it.",
      );
      assert.equal(
        busyRemoteRefusal(counted, "move"),
        "On that device, a worktree is still being moved. Wait for it to finish before moving the data folder.",
      );
      const refused = yield* Effect.flip(
        scripts.start({
          command: "exit 0",
          slot: { kind: "package", name: "during" },
          worktree,
          project: { id: project.id, path: repo, name: "repo" },
          notify: () => {},
        }),
      );
      assert.equal(refused.message, "This worktree is being moved.");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(moving);
    }),
  );
  assert.equal(busyDetail(await busy(), "quit"), null);
});

it("an auto-pull's fast-forward counts as a change while it runs", async () => {
  const origin = join(root, "pull-origin.git");
  const seed = join(root, "pull-seed");
  const pulling = join(root, "pulling");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", repo, seed);
  git(seed, "push", "-q", origin, "HEAD:main");
  git(root, "clone", "-q", origin, pulling);
  writeFileSync(join(seed, "b.txt"), "b\n");
  git(seed, "add", "b.txt");
  git(seed, "commit", "-q", "-m", "b");
  git(seed, "push", "-q", origin, "HEAD:main");
  git(pulling, "fetch", "-q");
  // Holds the pull's `git status` while `slow` exists.
  const slow = join(root, "pull.slow");
  const holding = join(root, "pull.holding");
  const hook = join(root, "pull-fsmonitor");
  writeFileSync(
    hook,
    `#!/bin/sh\n[ -f '${slow}' ] || exit 1\ntouch '${holding}'\nwhile [ -f '${slow}' ]; do sleep 0.05; done\nexit 1\n`,
  );
  chmodSync(hook, 0o755);
  git(pulling, "config", "core.fsmonitor", hook);
  writeFileSync(slow, "");
  const pull = runHost(
    autoPullWorktree(
      { projectId: "pulling", id: "pulling", path: pulling, detached: false },
      { busy: false },
    ),
  );
  try {
    await waitFor(() => existsSync(holding), "the pull's status check");
    assert.equal(
      busyDetail(await busy(), "quit"),
      "An auto-pull is still being made. Quitting now will interrupt it.",
    );
  } finally {
    rmSync(slow);
  }
  assert.deepEqual(await pull, { kind: "pulled", commits: 1 });
  assert.deepEqual((await busy()).engineChanges, []);
});
