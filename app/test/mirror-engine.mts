// Proof for the mirror engine as the host runs it
// (host/mirror/MirrorEngineLayer.ts), on the real layer over the real
// daemon supervisor (host/mirror/MirrorDaemon.ts): a mirror never opens
// onto a folder that isn't its own, and a stop never removes a copy it
// can't vouch for. The file-sync child is a fake that answers each
// request as the check says, since what is under test is what the engine
// does with the daemon's snapshots and answers, which a real engine
// cannot be made to give on cue. The clock is a TestClock.
//
// Asserts:
//   - a stop's fresh look at git that doesn't finish in its limit times
//     out, never answering the verdict from before it,
//   - a worktree made where a moved one was, gone outside the app, ends
//     its mirror rather than re-opening it on the moved one's folder,
//   - a moved original's re-open at a start waits, its session paused,
//     for the peer to take this device's calls, and the mirror ends, its
//     copy kept and never re-opened, when a worktree is made at the old
//     folder meanwhile, when the one it became is mirrored meanwhile, or
//     when the peer comes past 2 minutes, and a Stop while it waits keeps
//     the copy.
//
// Run: pnpm test mirror-engine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { it } from "vitest";
import * as FileSync from "../host/fileSync/FileSync.ts";
import * as HostAccount from "../host/lib/HostAccount.ts";
import * as Registry from "@shigomori/engine/Registry";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as MirrorDaemon from "../host/mirror/MirrorDaemon.ts";
import * as MirrorEngineLayer from "../host/mirror/MirrorEngineLayer.ts";
import * as MirrorGateway from "../host/mirror/MirrorGateway.ts";
import { makeGitFollower } from "../host/mirror/gitFollow.ts";
import { MIRROR_LABEL_LOCAL_PROJECT } from "../host/mirror/registry.ts";
import { stopMirror } from "../host/mirror/sessions.ts";
import { MIRROR_LABEL_MODE } from "@shigomori/contracts/modules/mirror";
import {
  sandboxGit,
  scrubProcessGitEnv,
  settleTurns,
  tempDir,
  testClock,
  waitFor,
} from "./lib/checkKit.mts";
import { standInPeers } from "./lib/hostStandIns.mts";
import { hostContext } from "./lib/hostRuntime.mts";
import { rawMirrorSession } from "./lib/mirrorFakes.mts";
import { trackTest } from "./lib/vitestKit.mts";

type Request = { id: string; op: string; session?: string };
type Answer =
  | { readonly ok: true; readonly session?: string }
  | { readonly ok: false; readonly error: string };

const root = mkdtempSync(join(tmpdir(), "sm-mirror-engine-"));

// The engine over a daemon whose child answers each request with what
// `answer` says.
async function harness(answer: (request: Request) => Answer) {
  const requests: Request[] = [];
  const out = Effect.runSync(Queue.unbounded<Uint8Array>());
  const write = (line: unknown) =>
    Queue.offerUnsafe(
      out,
      new TextEncoder().encode(JSON.stringify(line) + "\n"),
    );
  const fakeFileSync = Layer.succeed(
    FileSync.FileSync,
    FileSync.FileSync.of({
      spawn: (_args, { stdin }) =>
        Effect.gen(function* () {
          yield* stdin.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                const request = JSON.parse(line) as Request;
                requests.push(request);
                write({ id: request.id, ...answer(request) });
              }),
            ),
            Effect.ignore,
            Effect.forkScoped,
          );
          // The child's exit.
          const exit = yield* Deferred.make<number>();
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2),
            exitCode: Deferred.await(exit).pipe(
              Effect.map(ChildProcessSpawner.ExitCode),
            ),
            isRunning: Effect.succeed(true),
            kill: () => Deferred.succeed(exit, 137).pipe(Effect.asVoid),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(out).pipe(
              Stream.interruptWhen(Deferred.await(exit)),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      serve: () => Effect.die("no serve children here"),
    }),
  );
  const gateway = Layer.succeed(
    MirrorGateway.MirrorGateway,
    MirrorGateway.MirrorGateway.of({
      listening: Effect.succeed(
        Option.some({ address: "127.0.0.1:1", token: "token" }),
      ),
      streamCount: Effect.succeed(0),
    }),
  );
  const daemonRuntime = ManagedRuntime.make(
    MirrorDaemon.layer({ dataDir: () => "unused" }).pipe(
      Layer.provide(Layer.mergeAll(fakeFileSync, gateway)),
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(Layer.succeedContext(await hostContext())),
    ),
  );
  trackTest(() => daemonRuntime.dispose());
  const runtime = ManagedRuntime.make(
    MirrorEngineLayer.layer({
      onChange: () => {},
      projectChanged: () => {},
    }).pipe(
      Layer.provideMerge(HostAccount.layer),
      Layer.provideMerge(Layer.succeedContext(await daemonRuntime.context())),
    ),
  );
  trackTest(() => runtime.dispose());
  await runtime.runPromise(
    Effect.flatMap(HostAccount.HostAccount, (account) =>
      account.set({
        hubUrl: "http://127.0.0.1:1",
        accountId: "account",
        credential: "credential",
        deviceKey: "key",
        webOrigin: "",
        acceptsCommands: false,
      }),
    ),
  );
  write({ event: "ready" });
  await settleTurns();
  return {
    run: runtime.runPromise,
    requests: () =>
      requests.map((request) =>
        `${request.op} ${request.session ?? ""}`.trim(),
      ),
    // A state line from the daemon: the sessions it has.
    state: async (sessions: readonly ReturnType<typeof rawMirrorSession>[]) => {
      write({ event: "state", sessions });
      await settleTurns();
    },
    adjust: async (ms: number) => {
      await runtime.runPromise(TestClock.adjust(ms));
      await settleTurns();
    },
  };
}

it("a stop's fresh git check that doesn't finish in its limit times out, never answering the verdict from before it", async () => {
  const held = mkdtempSync(join(root, "held-"));
  // The peer answers the first look, then holds every later one.
  let holding = false;
  standInPeers({
    transportFor: () => ({
      invoke: (channel) =>
        holding && channel === "mirror:gitState"
          ? new Promise(() => {})
          : Promise.reject(new Error("the peer can't say")),
      subscribe: () => () => {},
    }),
    channelsFor: () => () => Promise.reject(new Error("not in this check")),
  });
  const project = await Effect.runPromiseWith(await hostContext())(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({ name: "held", path: held }),
    ),
  );
  const copy = rawMirrorSession({
    session: "s1",
    localRoot: held,
    deviceId: "B",
    projectId: "p",
    worktreeId: "copy",
    localWorktreeId: "w1",
    labels: {
      [MIRROR_LABEL_MODE]: "mirror",
      [MIRROR_LABEL_LOCAL_PROJECT]: project.id,
    },
  });
  const clock = testClock();
  const scope = Effect.runSync(Scope.make());
  trackTest(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const follower = await Effect.runPromiseWith(await hostContext())(
    makeGitFollower({
      sessions: Effect.succeed([copy]),
      sweepMs: 3_600_000,
      onCopyGone: () => {},
      log: () => {},
    }).pipe(Scope.provide(scope), Effect.provide(clock.context)),
  );
  await waitFor(
    () => follower.statusOf("s1") !== undefined,
    "the first look's verdict",
  );
  holding = true;
  const checked = Effect.runPromiseWith(clock.context)(
    follower.reconcileNow("s1"),
  );
  await clock.advance(10_000);
  assert.equal(
    await checked,
    "timed-out",
    "the stop read the verdict from before",
  );
});

it("a worktree made where a moved one was ends its mirror when it goes, never re-opening it on the moved one's folder", async () => {
  scrubProcessGitEnv();
  const git = sandboxGit();
  const { run, state, requests } = await harness(() => ({ ok: true }));
  const base = tempDir("sm-mirror-reused-", trackTest);
  const repo = join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "a");
  const reused = await run(
    Effect.gen(function* () {
      const project = yield* (yield* Registry.Registry).register({
        name: "repo",
        path: repo,
      });
      const worktrees = yield* Worktrees.Worktrees;
      const made = (branch: string) =>
        Effect.flatMap(
          worktrees.create(
            project,
            { name: "fox", branch, skipSetup: true },
            { report: () => Effect.void, color: false },
          ),
          (created) =>
            Effect.map(worktrees.identities(project), (found) => {
              const row = found.find(({ id }) => id === created.worktree.id);
              assert.ok(row !== undefined);
              return row;
            }),
        );
      const moved = yield* made("one");
      yield* worktrees.move(
        { project, worktree: moved },
        join(base, "elsewhere", "otter"),
      );
      const taken = yield* made("two");
      assert.equal(taken.path, moved.path);
      return taken;
    }),
  );
  rmSync(reused.path, { recursive: true, force: true });
  await state([
    rawMirrorSession({
      session: "s1",
      localRoot: reused.path,
      localWorktreeId: reused.id,
      labels: {
        [MIRROR_LABEL_MODE]: "mirror",
      },
    }),
  ]);
  await waitFor(
    () => requests().includes("terminate s1"),
    "the mirror of the worktree gone to end",
  );
  assert.deepEqual(requests(), ["terminate s1"]);
});

// A mirror into B of a worktree moved while the app was closed (the
// store records the move), as the daemon's first snapshot finds it
// with B not reached yet: the session's root gone and the session
// trying to connect. The bookkeeping has looked and paused it. `reach`
// brings B in. The session's id and the worktree's name are the
// check's own: the bookkeeping's marks (registry.ts) and the data
// folder outlive a check.
async function movedOriginalWithPeerAway(id: string) {
  scrubProcessGitEnv();
  const git = sandboxGit();
  const admissions = Effect.runSync(PubSub.unbounded<string>());
  const asked: string[] = [];
  let reached = false;
  standInPeers({
    transportFor: () => ({
      invoke: () => Promise.reject(new Error("not in this check")),
      subscribe: () => () => {},
    }),
    channelsFor: () => () => Promise.reject(new Error("not in this check")),
    admissions: Stream.fromPubSub(admissions),
    admits: (deviceId: string) => {
      asked.push(deviceId);
      return reached && deviceId === "B";
    },
  });
  // The engine opens a session only against both sides, so a create
  // fails while the peer is out of reach.
  const mirror = await harness((request) =>
    request.op !== "create"
      ? { ok: true }
      : reached
        ? { ok: true, session: "reopened" }
        : {
            ok: false,
            error: "unable to connect to beta: no direct connection to B",
          },
  );
  const base = tempDir("sm-mirror-late-peer-", trackTest);
  const repo = join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "a");
  // The original, moved while the app was closed: the store records it.
  const { project, original, moved } = await Effect.runPromiseWith(
    await hostContext(),
  )(
    Effect.gen(function* () {
      const registered = yield* (yield* Registry.Registry).register({
        name: "repo",
        path: repo,
      });
      const worktrees = yield* Worktrees.Worktrees;
      const created = yield* worktrees.create(
        registered,
        { name: `otter-${id}`, branch: "otter", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const row = (yield* worktrees.identities(registered)).find(
        (worktree) => worktree.id === created.worktree.id,
      );
      assert.ok(row !== undefined);
      const done = yield* worktrees.move(
        { project: registered, worktree: row },
        join(base, "elsewhere", "lynx"),
      );
      return { project: registered, original: row, moved: done.worktree };
    }),
  );
  const raw = (paused: boolean) =>
    rawMirrorSession({
      session: id,
      localRoot: original.path,
      localWorktreeId: original.id,
      deviceId: "B",
      status: "connecting-remote",
      paused,
      labels: { [MIRROR_LABEL_MODE]: "mirror" },
    });
  await mirror.state([raw(false)]);
  await waitFor(
    () => asked.includes("B") && mirror.requests().includes(`pause ${id}`),
    "the re-open to wait on the peer, its session paused",
  );
  // The daemon's next snapshot, which says so, and the look it starts,
  // which asks after B again.
  const looked = asked.length;
  await mirror.state([raw(true)]);
  await waitFor(
    () => asked.length > looked,
    "the paused session's look to ask after its peer",
  );
  return {
    ...mirror,
    moved,
    raw,
    reach: () => {
      reached = true;
      PubSub.publishUnsafe(admissions, "B");
    },
    // A worktree made at the old folder, which takes the old id, as ids
    // are path derived.
    takeOldFolder: async () => {
      const made = await Effect.runPromiseWith(await hostContext())(
        Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
          worktrees.create(
            project,
            { name: `otter-${id}`, branch: "fox", skipSetup: true },
            { report: () => Effect.void, color: false },
          ),
        ),
      );
      assert.equal(made.worktree.id, original.id);
    },
  };
}

it("a moved original's mirror waiting on its peer ends, its copy kept, when a worktree is made at the old folder, never mirroring that one", async () => {
  const { requests, takeOldFolder } = await movedOriginalWithPeerAway("taken");
  await takeOldFolder();
  await waitFor(
    () => requests().includes("terminate taken"),
    "the waiting mirror to end",
  );
  assert.deepEqual(requests(), ["pause taken", "terminate taken"]);
});

it("a moved original's mirror whose peer comes past 2 minutes of waiting ends, its copy kept, never re-opening on what drifted apart meanwhile", async () => {
  const { requests, reach, adjust } = await movedOriginalWithPeerAway("past");
  await adjust(2 * 60_000 + 1);
  reach();
  await waitFor(
    () => requests().includes("terminate past"),
    "the waiting mirror to end",
  );
  assert.deepEqual(requests(), ["pause past", "terminate past"]);
});

it("a moved original's mirror waiting on its peer ends, its copy kept, when the worktree it became is mirrored meanwhile, never giving it a second mirror", async () => {
  const { requests, state, reach, moved, raw } =
    await movedOriginalWithPeerAway("twice");
  await state([
    raw(true),
    rawMirrorSession({
      session: "twice-to-c",
      localRoot: moved.path,
      localWorktreeId: moved.id,
      deviceId: "C",
      labels: { [MIRROR_LABEL_MODE]: "mirror" },
    }),
  ]);
  await waitFor(
    () => requests().includes("terminate twice"),
    "the waiting mirror to end",
  );
  reach();
  await settleTurns();
  assert.deepEqual(requests(), ["pause twice", "terminate twice"]);
});

it("a Stop of a moved original's mirror waiting on its peer ends it, its copy kept", async () => {
  const { requests, run } = await movedOriginalWithPeerAway("stop");
  assert.deepEqual(await run(stopMirror("stop", false)), {
    removedCopy: false,
  });
  assert.deepEqual(requests(), ["pause stop", "terminate stop"]);
});
