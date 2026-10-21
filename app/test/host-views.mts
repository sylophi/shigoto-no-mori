// The host's views (host/lib/Views.ts and each module's `*Views`): every
// one answers its query's value first, then again after a write through
// the engine (or the push the write makes), and says nothing while the
// value stays the same. The store's backstop and the views' polls run
// on a TestClock.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as EngineConfig from "@shigomori/engine/Config";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { callOf, channelOf } from "@shigomori/contracts/contract";
import type { ChangedFile, Project } from "@shigomori/contracts/schemas";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, beforeAll, it } from "vitest";
import { globalConfigViews } from "../host/ipc/modules/globalConfig.ts";
import { mirrorViews } from "../host/ipc/modules/mirror.ts";
import { portsViews } from "../host/ipc/modules/ports.ts";
import { projectsViews } from "../host/ipc/modules/projects.ts";
import { scriptsViews } from "../host/ipc/modules/scripts.ts";
import { sharedSettingsViews } from "../host/ipc/modules/sharedSettings.ts";
import {
  worktreesHandlers,
  worktreesViews,
} from "../host/ipc/modules/worktrees.ts";
import * as Ops from "../host/lib/engineOps.ts";
import { GitWatcher } from "../host/lib/GitWatcher.ts";
import * as HostPushes from "../host/lib/HostPushes.ts";
import * as Views from "../host/lib/Views.ts";
import * as Sharing from "../host/lib/Sharing.ts";
import { listWorktrees } from "../host/lib/projects/index.ts";
import { addProject } from "../host/lib/projects/index.ts";
import * as Scripts from "../host/lib/Scripts.ts";
import { sharedSettingsCopy } from "../host/lib/sharedSettings/store.ts";
import { initDataDirAt } from "../shared/paths.ts";
import type { MirrorEngine } from "../host/mirror/MirrorEngine.ts";
import { standInMirror } from "./lib/hostStandIns.mts";
import {
  engineDataDir,
  hostContext,
  runHost,
  type Services as HostServices,
} from "./lib/hostRuntime.mts";
import {
  makeTracker,
  sandboxGit,
  scriptEnv,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

// The host's git runs in this process: a commit hook's GIT_* would point
// it at the repository being committed.
scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let repo: string;

beforeAll(async () => {
  initDataDirAt(engineDataDir);
  repo = join(tempDir("sm-views-", track), "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
});
afterAll(async () => {
  await runHost(
    Effect.flatMap(Scripts.Scripts, (scripts) =>
      scripts.stopAll({ graceMs: 0 }),
    ),
  );
  await teardown();
});

type Services = Views.Services | HostServices;

// The git watcher's index writes, as the checks below make them.
const indexWrites = Effect.runSync(PubSub.unbounded<string>());
const indexWritten = (projectId: string) =>
  PubSub.publish(indexWrites, projectId);
const gitWatcherLayer = Layer.succeed(
  GitWatcher,
  GitWatcher.of({
    reconcile: Effect.void,
    indexWritten: PubSub.subscribe(indexWrites).pipe(
      Effect.map(Stream.fromSubscription),
    ),
  }),
);

// A view watched: `next` is its next value, `push` makes a host push as
// the broadcast seam would, `tick` moves the clock past the store's
// backstop look (or a view's poll), and `quiet` says nothing more came.
const watch = <A,>(
  stream: Stream.Stream<A, unknown, Services>,
  body: (watching: {
    readonly first: A;
    readonly next: Effect.Effect<A>;
    readonly tick: (by?: Duration.Input) => Effect.Effect<void>;
    readonly push: (channel: string) => Effect.Effect<void>;
    readonly quiet: Effect.Effect<void>;
  }) => Effect.Effect<void, unknown, Services | Scope.Scope>,
) =>
  runHost(
    Effect.gen(function* () {
      const values = yield* Stream.toQueue(stream, { capacity: "unbounded" });
      const next = Queue.take(values).pipe(Effect.orDie);
      // Subscribed by the time the first value is read.
      const first = yield* next;
      const pushes = yield* HostPushes.HostPushes;
      yield* body({
        first,
        next,
        tick: (by = "10 seconds") => TestClock.adjust(by),
        push: (channel) =>
          pushes.publish({ channel, payload: undefined, remote: true }),
        quiet: Effect.promise(
          () => new Promise((r) => setTimeout(r, 300)),
        ).pipe(
          Effect.andThen(Queue.size(values)),
          Effect.map((size) => assert.equal(size, 0, "nothing new came")),
        ),
      });
    }).pipe(
      Effect.scoped,
      // The store's backstop and the views' polls run on the TestClock
      // the body moves.
      // The host's services beneath, the proof file's own.
      Effect.provide(
        Layer.mergeAll(
          StoreChanges.layer,
          HostPushes.layer,
          Views.layer,
          gitWatcherLayer,
        ).pipe(
          Layer.provideMerge(TestClock.layer()),
          Layer.provideMerge(Layer.effectContext(Effect.promise(hostContext))),
        ),
      ),
    ),
  );

const channel = <M extends Parameters<typeof callOf>[0]>(
  module: M,
  key: string,
) => channelOf(callOf(module, key));

const refused = () => Effect.die(new Error("not in this check"));

const stagedOf = (files: ReadonlyArray<ChangedFile>) =>
  files.map((file) => [file.path, file.staged]);

let project: Project;
let projectId: string;
const primaryId = async () => {
  const [primary] = await runHost(listWorktrees(projectId));
  assert.ok(primary !== undefined);
  return primary.id;
};

it("projects: a project registered through the engine joins the list", async () => {
  await watch(projectsViews.watch(undefined), ({ first, next, tick, quiet }) =>
    Effect.gen(function* () {
      assert.ok(first.every((listed) => listed.path !== repo));
      project = yield* addProject(repo);
      projectId = project.id;
      yield* tick();
      const after = yield* next;
      assert.ok(after.some((listed) => listed.id === projectId));
      // A look with nothing written says nothing.
      yield* tick();
      yield* quiet;
    }),
  );
});

it("worktrees: an auto-pull mark set through the engine shows on its row", async () => {
  await watch(worktreesViews.watch({ projectId }), ({ first, next, tick }) =>
    Effect.gen(function* () {
      const primary = first[0];
      assert.ok(primary !== undefined);
      assert.equal(primary.autoPull, false);
      yield* Ops.setAutoPull(project, primary.id, true);
      yield* tick();
      const [row] = yield* next;
      assert.equal(row?.autoPull, true);
    }),
  );
});

it("a worktree's changes: an edit shows on the files push, a stage on its project's index written, a commit on the project's git ping, and nothing on the clock", async () => {
  const worktreeId = await primaryId();
  await watch(
    worktreesViews.watchChangeStatus({ projectId, worktreeId }),
    ({ first, next, tick, quiet }) =>
      Effect.gen(function* () {
        const pushes = yield* HostPushes.HostPushes;
        assert.deepEqual(first, []);
        writeFileSync(join(repo, "b.txt"), "b\n");
        // No poll: the edit waits for a watch to say so.
        yield* tick("10 seconds");
        yield* quiet;
        // The working tree's watch, as the app's broadcast makes it.
        yield* pushes.publish({
          channel: channel(worktreesContract, "filesChanged"),
          payload: { projectId },
          remote: true,
        });
        assert.deepEqual(stagedOf(yield* next), [["b.txt", "none"]]);
        git(repo, "add", "b.txt");
        yield* indexWritten(projectId);
        assert.deepEqual(stagedOf(yield* next), [["b.txt", "all"]]);
        // Another project's index says nothing of this one's.
        git(repo, "reset", "-q", "b.txt");
        yield* indexWritten("another");
        yield* quiet;
        yield* indexWritten(projectId);
        assert.deepEqual(stagedOf(yield* next), [["b.txt", "none"]]);
        git(repo, "add", "b.txt");
        git(repo, "commit", "-q", "-m", "b");
        // The git watcher's ping, as the app's broadcast makes it.
        yield* pushes.publish({
          channel: "git:projectChanged",
          payload: { projectId },
          remote: true,
        });
        assert.deepEqual(yield* next, []);
      }),
  );
});

it("a worktree's changes: a refresh reads now and answers once that read landed, changed or not, and at once with nothing watching", async () => {
  const input = { projectId, worktreeId: await primaryId() };
  // Nothing watches the list: there is no read to ask for.
  await runHost(
    worktreesHandlers
      .refreshChangeStatus(input)
      .pipe(Effect.provide(Views.layer)),
  );
  await watch(
    worktreesViews.watchChangeStatus(input),
    ({ first, next, quiet }) =>
      Effect.gen(function* () {
        assert.deepEqual(first, []);
        // An edit no watch reported: the refresh reads it.
        writeFileSync(join(repo, "c.txt"), "c\n");
        yield* worktreesHandlers.refreshChangeStatus(input);
        assert.deepEqual(
          (yield* next).map((file) => file.path),
          ["c.txt"],
        );
        // Nothing moved: the refresh still answers, and says nothing.
        yield* worktreesHandlers.refreshChangeStatus(input);
        yield* quiet;
        rmSync(join(repo, "c.txt"));
        yield* worktreesHandlers.refreshChangeStatus(input);
        assert.deepEqual(yield* next, []);
      }),
  );
});

it("a worktree's tree: one refresh reads the file's diff and hunks and the operation with the list", async () => {
  const input = { projectId, worktreeId: await primaryId() };
  writeFileSync(join(repo, "a.txt"), "a\nmore\n");
  await watch(
    worktreesViews.watchFileDiff({
      ...input,
      paths: ["a.txt"],
      untracked: false,
    }),
    ({ first, next }) =>
      Effect.gen(function* () {
        assert.match(first, /\+more/);
        // An edit no watch reported: the refresh of the tree reads the
        // diff too.
        writeFileSync(join(repo, "a.txt"), "a\nmore\nstill\n");
        yield* worktreesHandlers.refreshChangeStatus(input);
        assert.match(yield* next, /\+still/);
        git(repo, "checkout", "--", "a.txt");
        yield* worktreesHandlers.refreshChangeStatus(input);
        assert.equal(yield* next, "");
      }),
  );
  await watch(worktreesViews.watchOperation(input), ({ first }) =>
    Effect.sync(() => assert.equal(first.operation, null)),
  );
});

it("a worktree's stashes: a stash made outside the app shows on the project's git ping", async () => {
  const input = { projectId, worktreeId: await primaryId() };
  await watch(worktreesViews.watchStashes(input), ({ first, next }) =>
    Effect.gen(function* () {
      assert.deepEqual(first, []);
      writeFileSync(join(repo, "a.txt"), "a\nstashed\n");
      git(repo, "stash", "push", "-m", "kept");
      yield* Effect.flatMap(HostPushes.HostPushes, (pushes) =>
        pushes.publish({
          channel: "git:projectChanged",
          payload: { projectId },
          remote: true,
        }),
      );
      const [stash] = yield* next;
      assert.equal(stash?.message, "kept");
      git(repo, "stash", "drop");
    }),
  );
});

it("a refresh waiting on a read ends when the view's last reader goes", async () => {
  await runHost(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let reads = 0;
      // The first read answers, every later one waits on the gate.
      const view = Views.view(
        "test:refresh-gone",
        () =>
          Effect.suspend(() =>
            (reads += 1) === 1 ? Effect.succeed(0) : Deferred.await(gate),
          ),
        () => false,
      );
      const scope = yield* Scope.make();
      const values = yield* Stream.toQueue(view, {
        capacity: "unbounded",
      }).pipe(Scope.provide(scope));
      yield* Queue.take(values);
      const waiting = yield* Effect.forkChild(
        Views.refresh("test:refresh-gone"),
      );
      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(waiting);
      // With no reader left there is nothing to wait on.
      yield* Views.refresh("test:refresh-gone");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(StoreChanges.layer, HostPushes.layer, Views.layer).pipe(
          Layer.provideMerge(Layer.effectContext(Effect.promise(hostContext))),
        ),
      ),
    ),
  );
});

it("ports: a port added through the engine joins the list", async () => {
  const worktreeId = await primaryId();
  await watch(
    portsViews.watch({ projectId, worktreeId }),
    ({ first, next, tick }) =>
      Effect.gen(function* () {
        assert.deepEqual(first.ports, []);
        yield* Ops.writeWorktreeData(projectId, worktreeId, {
          ports: [{ port: 45_123, label: "api" }],
        });
        yield* tick();
        const after = yield* next;
        assert.deepEqual(
          after.ports.map((port) => port.port),
          [45_123],
        );
      }),
  );
});

it("settings: a device setting written through the engine", async () => {
  await watch(globalConfigViews.watch(undefined), ({ first, next, tick }) =>
    Effect.gen(function* () {
      assert.equal(first.hiddenLaunchers, undefined);
      yield* Ops.patchGlobalConfig({ hiddenLaunchers: ["app:zed"] });
      yield* tick();
      assert.deepEqual((yield* next).hiddenLaunchers, ["app:zed"]);
    }),
  );
});

it("sharing: set from the account page, then by a terminal's write, the switch moves and says so once per change, stored only while off", async () => {
  const announced: boolean[] = [];
  await runHost(
    Effect.gen(function* () {
      const sharing = yield* Sharing.Sharing;
      const config = yield* EngineConfig.Config;
      const changes = yield* Stream.toQueue(sharing.changes, {
        capacity: "unbounded",
      });
      const next = Queue.take(changes).pipe(Effect.orDie);
      assert.equal(yield* next, true, "on until switched off");
      yield* sharing.set(false);
      assert.equal(yield* next, false);
      const stored = yield* config.read({ kind: "device" });
      assert.equal(stored?.["shareWithDevices"], false);
      yield* sharing.set(false);
      // The key dropped by a store write that isn't the switch's, as
      // `sm config edit` does when its line is deleted.
      yield* config.change({ kind: "device" }, (doc) => {
        const { shareWithDevices: _, ...rest } = doc;
        return rest;
      });
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* next, true);
      assert.equal(yield* sharing.current, true);
      assert.deepEqual(announced, [false, true]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sharing.layer({ announce: (on) => announced.push(on) }).pipe(
          Layer.provideMerge(StoreChanges.layer),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  );
});

it("shared settings: a pick, on the push its write makes", async () => {
  await watch(sharedSettingsViews.watch(undefined), ({ first, next, push }) =>
    Effect.gen(function* () {
      assert.deepEqual(first.entries, {});
      sharedSettingsCopy.set("quickCreateDevice/r", "device-1");
      yield* push(channel(sharedSettingsContract, "changed"));
      const after = yield* next;
      assert.equal(after.entries["quickCreateDevice/r"]?.value, "device-1");
    }),
  );
});

it("script runs: a run started shows, on scripts:changed", async () => {
  await watch(scriptsViews.watch(undefined), ({ first, next, push, quiet }) =>
    Effect.gen(function* () {
      assert.deepEqual(first.runs, []);
      // The same list again says nothing.
      yield* push(channel(scriptsContract, "changed"));
      yield* quiet;
      const runId = yield* Effect.promise(() =>
        runHost(
          Effect.flatMap(Scripts.Scripts, (scripts) =>
            scripts.start({
              command: "sleep 60",
              slot: { kind: "package", name: "views" },
              worktree: { id: "wt", name: "wt", branch: "main", path: repo },
              project: { id: "p", path: repo, name: "p" },
              scriptEnv,
              notify: () => {},
            }),
          ),
        ),
      );
      yield* push(channel(scriptsContract, "changed"));
      const after = yield* next;
      assert.deepEqual(
        after.runs.map((run) => run.runId),
        [runId],
      );
    }),
  );
});

it("mirrors: the daemon coming up, on mirror:changed", async () => {
  let status: Effect.Success<MirrorEngine["Service"]["status"]> = "starting";
  standInMirror({
    status: Effect.sync(() => status),
    failure: Effect.succeed(undefined),
    sessions: Effect.succeed([]),
    fresh: Effect.succeed(true),
    create: refused,
    recreate: refused,
    terminate: refused,
    pause: refused,
    resume: refused,
    gitStatus: () => ({ status: "following", detail: "" }),
    refreshGit: refused,
    history: () => [],
    noteEvent: () => {},
    releaseCopy: () => Effect.void,
    forgetHistory: () => {},
    moveHistory: () => {},
    localProjectChanged: () => {},
    peerProjectChanged: () => {},
    peerWorktreeChanged: () => {},
    leaveAccount: Effect.void,
  });
  await watch(mirrorViews.watch(undefined), ({ first, next, push }) =>
    Effect.gen(function* () {
      assert.equal(first.daemon, "starting");
      status = "running";
      yield* push(channel(mirrorContract, "changed"));
      assert.equal((yield* next).daemon, "running");
    }),
  );
});

it("one read per view and input: a second subscriber joins it on the current value, and the read ends with its last subscriber", async () => {
  let reads = 0;
  let value = 0;
  const bump = "test:bump";
  const counted = (key: string) =>
    Views.view(
      key,
      () =>
        Effect.sync(() => {
          reads += 1;
          return value;
        }),
      (signal) => signal.kind === "push" && signal.push.channel === bump,
    );
  const subscribe = (key: string) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const values = yield* Stream.toQueue(counted(key), {
        capacity: "unbounded",
      }).pipe(Scope.provide(scope));
      return {
        next: Queue.take(values).pipe(Effect.orDie),
        end: Scope.close(scope, Exit.void),
      };
    });
  await watch(Stream.make(0), ({ push }) =>
    Effect.gen(function* () {
      const first = yield* subscribe("test:a");
      assert.equal(yield* first.next, 0);
      const second = yield* subscribe("test:a");
      assert.equal(yield* second.next, 0, "the late one starts from it");
      assert.equal(reads, 1, "one read for both");
      // Another input is a read of its own.
      const other = yield* subscribe("test:b");
      assert.equal(yield* other.next, 0);
      assert.equal(reads, 2);
      yield* other.end;

      value = 1;
      yield* push(bump);
      assert.equal(yield* first.next, 1);
      assert.equal(yield* second.next, 1);
      assert.equal(reads, 3, "one read for the change");

      // The first gone, the read goes on for the second.
      yield* first.end;
      value = 2;
      yield* push(bump);
      assert.equal(yield* second.next, 2);
      assert.equal(reads, 4);
      yield* second.end;
      const again = yield* subscribe("test:a");
      assert.equal(yield* again.next, 2);
      assert.equal(reads, 5, "the last one gone, the next reads afresh");
      yield* again.end;
    }),
  );
});
