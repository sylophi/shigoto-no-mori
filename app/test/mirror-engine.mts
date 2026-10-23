// Proof for the mirror engine as the host runs it
// (host/mirror/MirrorEngineLayer.ts): its multi-step recreate and the
// sweep of a device leaving its account, on the real layer over the
// real daemon supervisor (host/mirror/MirrorDaemon.ts). The file-sync
// child is a fake that answers each request as the check says, since
// what is under test is what the engine does when a step between two
// of its requests fails, which a real engine cannot be made to do on
// cue. The clock is a TestClock.
//
// Asserts:
//   - a recreate pauses the old session, creates the new one, ends the
//     old one and answers the new id,
//   - a pause that fails creates nothing and ends nothing,
//   - a create that fails resumes the old session and reports the
//     create's refusal, a resume that fails as well included,
//   - a terminate that fails on a session already gone is the old
//     session ended, and one that fails on a session still listed
//     fails the recreate,
//   - an interrupt between the pause and the new session resumes the
//     old one,
//   - a recreate moves the follower's agreement to the new id, and a
//     terminate forgets it, one that fails included,
//   - a snapshot the daemon took before the engine was built still runs
//     the engine's bookkeeping: an orphaned transfer in it is ended,
//   - an engine whose stores cannot be read answers as unavailable and
//     refuses every change, saying why,
//   - an orphaned transfer whose end fails is asked again,
//   - the bookkeeping waits for a restarted daemon's own snapshot,
//   - a worktree made where a moved one was, gone outside the app, ends
//     its mirror rather than re-opening it on the moved one's folder,
//   - a transfer whose daemon stops and doesn't come back fails at the
//     missing ceiling, not the settle ceiling,
//   - a daemon restarting keeps the list and the git follower's verdict
//     its sessions had, and the threads note nothing of it,
//   - a thread says a lost link and its return, never the cut stream's
//     error, and an error from before stands until the link is back,
//     while the sync's own error, which leaves the link down too, is
//     noted,
//   - a thread notes git agreeing again across a spell of git off,
//   - a peer coming to take this device's calls reconnects its sessions
//     waiting on the link at once and side by side, none paused, halted
//     or held by a re-open and no other device's, and git looks at its
//     sessions again,
//   - the hub's status snapshots admit a peer as its direct session is
//     up with both of its switches on, once, and again after it left,
//   - the follower's copy-gone report, once a minute, counts elapsed
//     time: a wall clock stepped back neither holds the next one off
//     nor a step forward lets it through early,
//   - a worktree re-keyed with no host hook (an adopt, a project
//     relocate, as the terminal makes them) carries its thread to its
//     new id, and the daemon's next snapshot re-opens a session on it at
//     its new path,
//   - a device leaving its account ends its sessions within the
//     sweep's bound: a terminate the daemon never answers is given up
//     at 5 s, and an answer that comes later notes nothing on the
//     thread, since the sweep did not go on running,
//   - a moved original's re-open at a start waits, its session paused,
//     for the peer to take this device's calls, and the mirror ends, its
//     copy kept and its thread on the worktree it became, when a
//     worktree is made at the old folder meanwhile, when the one it
//     became is mirrored meanwhile, or when the peer comes past 2
//     minutes.
//
// Run: pnpm test mirror-engine.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
import * as PeerReach from "../host/ipc/PeerReach.ts";
import * as HostAccount from "../host/lib/HostAccount.ts";
import * as MirrorAgreements from "@shigomori/engine/MirrorAgreements";
import * as MirrorHistoryStore from "@shigomori/engine/MirrorHistory";
import * as Registry from "@shigomori/engine/Registry";
import * as Worktrees from "@shigomori/engine/Worktrees";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as MirrorDaemon from "../host/mirror/MirrorDaemon.ts";
import {
  type MirrorCreateInput,
  MirrorEngine,
  MirrorError,
} from "../host/mirror/MirrorEngine.ts";
import * as MirrorEngineLayer from "../host/mirror/MirrorEngineLayer.ts";
import * as MirrorGateway from "../host/mirror/MirrorGateway.ts";
import { makeGitFollower } from "../host/mirror/gitFollow.ts";
import { createMirrorHistory } from "../host/mirror/history.ts";
import { MIRROR_LABEL_LOCAL_PROJECT } from "../host/mirror/registry.ts";
import { transferFilesOnce } from "../host/mirror/oneShot.ts";
import { mirrorList } from "../host/mirror/sessions.ts";
import { MIRROR_LABEL_MODE } from "@shigomori/contracts/modules/mirror";
import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import {
  sandboxGit,
  scrubProcessGitEnv,
  settleTurns,
  sleepingClock,
  tempDir,
  testClock,
  waitFor,
} from "./lib/checkKit.mts";
import { standInPeers } from "./lib/hostStandIns.mts";
import { hostContext } from "./lib/hostRuntime.mts";
import {
  inertMirrorImpl,
  mirrorEndpoint,
  rawMirrorSession,
} from "./lib/mirrorFakes.mts";
import { trackTest } from "./lib/vitestKit.mts";

type Request = { id: string; op: string; session?: string };
type Answer =
  | { readonly ok: true; readonly session?: string }
  | { readonly ok: false; readonly error: string };

const root = mkdtempSync(join(tmpdir(), "sm-mirror-engine-"));
const session = (id: string, worktreeId = "") =>
  rawMirrorSession({
    session: id,
    localRoot: root,
    localWorktreeId: worktreeId,
  });

const input: MirrorCreateInput = {
  localRoot: root,
  deviceId: "B",
  projectId: "p",
  worktreeId: "0123456789ab",
  remoteRoot: "/b",
  name: "mirror-w",
  localWorktreeId: "w",
  labels: {},
  ignores: [],
};

// The engine over a daemon whose child answers each request with what
// `answer` says, or holds it while `answer` says null. The daemon comes
// up first, having reported `early` when given before the engine is
// built over it, and `stores` stands in for the engine's own.
async function harness(
  answer: (request: Request) => Answer | null,
  options: {
    readonly early?: readonly ReturnType<typeof session>[];
    readonly stores?: Layer.Layer<MirrorHistoryStore.MirrorHistory>;
  } = {},
) {
  const requests: Request[] = [];
  const held: Request[] = [];
  // One per spawn: the child's exit.
  const exits: Deferred.Deferred<number>[] = [];
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
                const answered = answer(request);
                if (answered === null) held.push(request);
                else write({ id: request.id, ...answered });
              }),
            ),
            Effect.ignore,
            Effect.forkScoped,
          );
          const exit = yield* Deferred.make<number>();
          exits.push(exit);
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
  const daemonSessions = () =>
    daemonRuntime.runSync(MirrorDaemon.MirrorDaemon.use((d) => d.sessions));
  if (options.early !== undefined) {
    write({ event: "ready" });
    write({ event: "state", sessions: options.early });
    await waitFor(
      () => daemonSessions().length === options.early?.length,
      "the daemon to report its sessions",
    );
  }
  const runtime = ManagedRuntime.make(
    MirrorEngineLayer.layer({
      onChange: () => {},
      projectChanged: () => {},
    }).pipe(
      Layer.provideMerge(HostAccount.layer),
      Layer.provide(options.stores ?? Layer.empty),
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
  if (options.early === undefined) write({ event: "ready" });
  await settleTurns();
  const engine = <A, E>(
    f: (engine: MirrorEngine["Service"]) => Effect.Effect<A, E>,
  ) => runtime.runPromiseExit(Effect.flatMap(MirrorEngine, f));
  return {
    engine,
    run: runtime.runPromise,
    close: () => runtime.dispose(),
    // The daemon's child exits, as a crash ends it.
    crash: async () => {
      const exit = exits.at(-1);
      assert.ok(exit !== undefined, "no child was spawned");
      Effect.runSync(Deferred.succeed(exit, 1));
      await settleTurns();
    },
    // A line from the daemon, as it writes one.
    write: async (line: unknown) => {
      write(line);
      await settleTurns();
    },
    // The engine's call, as a fiber a check can interrupt.
    fork: <A, E>(f: (engine: MirrorEngine["Service"]) => Effect.Effect<A, E>) =>
      runtime.runFork(Effect.flatMap(MirrorEngine, f)),
    requests: () =>
      requests.map((request) =>
        `${request.op} ${request.session ?? ""}`.trim(),
      ),
    held,
    signOut: () =>
      runtime.runPromise(
        Effect.flatMap(HostAccount.HostAccount, (account) => account.set(null)),
      ),
    // A state line from the daemon: the sessions it has.
    state: async (sessions: readonly ReturnType<typeof session>[]) => {
      write({ event: "state", sessions });
      await settleTurns();
    },
    answerHeld: async (request: Request, answered: Answer) => {
      write({ id: request.id, ...answered });
      await settleTurns();
    },
    adjust: async (ms: number) => {
      await runtime.runPromise(TestClock.adjust(ms));
      await settleTurns();
    },
    history: (worktreeId: string) =>
      runtime.runSync(
        Effect.map(MirrorEngine, (mirrors) => mirrors.history(worktreeId)),
      ),
  };
}

// The git state both sides of a session last agreed on.
const agreed = {
  head: { kind: "branch", branch: "main" },
  tip: "a".repeat(40),
  indexTree: "b".repeat(40),
} as const;

// The follower's agreements as the store has them, read and written
// on the engine's own store.
const agreements = {
  save: async (entries: Record<string, typeof agreed>) =>
    Effect.runPromiseWith(await hostContext())(
      MirrorAgreements.MirrorAgreements.use((store) => store.save(entries)),
    ),
  load: async () =>
    Effect.runPromiseWith(await hostContext())(
      MirrorAgreements.MirrorAgreements.use((store) => store.load),
    ),
};

const refusalOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined;
  const error = Cause.squash(exit.cause);
  return error instanceof MirrorError ? error.reason : undefined;
};
const succeeded = <A,>(exit: Exit.Exit<A, unknown>) => {
  assert.ok(Exit.isSuccess(exit), `failed: ${String(exit)}`);
  return exit.value;
};

it("a recreate pauses the old session, makes the new one, ends the old one", async () => {
  const { engine, requests, state } = await harness((request) =>
    request.op === "create" ? { ok: true, session: "new" } : { ok: true },
  );
  await state([session("old")]);
  const exit = await engine((mirrors) => mirrors.recreate("old", input));
  assert.equal(succeeded(exit), "new");
  assert.deepEqual(requests(), ["pause old", "create", "terminate old"]);
});

it("a create while signed out is refused before the daemon is asked", async () => {
  const { engine, requests, signOut } = await harness(() => ({ ok: true }));
  await signOut();
  const exit = await engine((mirrors) => mirrors.create(input));
  assert.equal(
    refusalOf(exit),
    "This device is signed out, so it cannot mirror.",
  );
  assert.deepEqual(requests(), []);
});

it("a pause that fails makes nothing and ends nothing", async () => {
  const { engine, requests, state } = await harness((request) =>
    request.op === "pause"
      ? { ok: false, error: "no such session" }
      : { ok: true },
  );
  await state([session("old")]);
  const exit = await engine((mirrors) => mirrors.recreate("old", input));
  assert.equal(refusalOf(exit), "no such session");
  assert.deepEqual(requests(), ["pause old"]);
});

it("a create that fails resumes the old session, and reports the create's refusal even when the resume fails too", async () => {
  for (const resume of [
    { ok: true },
    { ok: false, error: "resume failed" },
  ] as const) {
    const { engine, requests, state } = await harness((request) =>
      request.op === "create"
        ? { ok: false, error: "the peer is away" }
        : request.op === "resume"
          ? resume
          : { ok: true },
    );
    await state([session("old")]);
    const exit = await engine((mirrors) => mirrors.recreate("old", input));
    assert.equal(refusalOf(exit), "the peer is away");
    assert.deepEqual(requests(), ["pause old", "create", "resume old"]);
  }
});

it("a terminate that fails on a session already gone ends the old one all the same, and one still listed fails the recreate", async () => {
  {
    const { engine, state } = await harness((request) =>
      request.op === "create"
        ? { ok: true, session: "new" }
        : request.op === "terminate"
          ? { ok: false, error: "no such session" }
          : { ok: true },
    );
    await state([session("new")]);
    assert.equal(
      succeeded(await engine((mirrors) => mirrors.recreate("old", input))),
      "new",
    );
  }
  {
    const { engine, state } = await harness((request) =>
      request.op === "create"
        ? { ok: true, session: "new" }
        : request.op === "terminate"
          ? { ok: false, error: "terminate failed" }
          : { ok: true },
    );
    await state([session("old"), session("new")]);
    const exit = await engine((mirrors) => mirrors.recreate("old", input));
    assert.equal(refusalOf(exit), "terminate failed");
  }
});

it("a device leaving its account gives up a terminate the daemon never answers at 5 s, and a late answer notes nothing", async () => {
  const { engine, held, state, adjust, answerHeld, history } = await harness(
    (request) => (request.op === "terminate" ? null : { ok: true }),
  );
  await state([session("stuck", "w1")]);
  let left = false;
  const leaving = engine((mirrors) => mirrors.leaveAccount).then((exit) => {
    left = true;
    return exit;
  });
  await settleTurns();
  assert.equal(held.length, 1, "the sweep asked for no terminate");
  await adjust(4_999);
  assert.equal(left, false, "the sweep gave up before its bound");
  await adjust(1);
  succeeded(await leaving);
  const [stuck] = held;
  assert.ok(stuck !== undefined);
  await answerHeld(stuck, { ok: true });
  assert.deepEqual(
    history("w1").filter((event) => event.kind === "stopped"),
    [],
    "the sweep went on past its bound",
  );
});

it("an interrupt between the pause and the new session resumes the old one", async () => {
  const { fork, held, requests, state } = await harness((request) =>
    request.op === "create" ? null : { ok: true },
  );
  await state([session("old")]);
  const recreating = fork((mirrors) => mirrors.recreate("old", input));
  await waitFor(
    () => held.some((request) => request.op === "create"),
    "the create to be asked",
  );
  await Effect.runPromise(Fiber.interrupt(recreating));
  await settleTurns();
  assert.deepEqual(requests(), ["pause old", "create", "resume old"]);
});

it("a recreate moves the follower's agreement to the new id, and a terminate forgets it, one that fails included", async () => {
  await agreements.save({ old: agreed, ended: agreed, refused: agreed });
  const { engine, state } = await harness((request) =>
    request.op === "create"
      ? { ok: true, session: "new" }
      : request.op === "terminate" && request.session === "refused"
        ? { ok: false, error: "terminate failed" }
        : { ok: true },
  );
  await state([session("old"), session("ended"), session("refused")]);
  assert.equal(
    succeeded(await engine((mirrors) => mirrors.recreate("old", input))),
    "new",
  );
  succeeded(await engine((mirrors) => mirrors.terminate("ended")));
  assert.equal(
    refusalOf(await engine((mirrors) => mirrors.terminate("refused"))),
    "terminate failed",
  );
  await waitFor(
    async () => Object.keys(await agreements.load()).join() === "new",
    "the agreements to read the new id alone",
  );
  assert.deepEqual(await agreements.load(), { new: agreed });
  await agreements.save({});
});

it("a snapshot the daemon took before the engine was built still ends an orphaned transfer", async () => {
  const orphan = rawMirrorSession({
    session: "orphan",
    localRoot: root,
    labels: { [MIRROR_LABEL_MODE]: "transfer-a-token-nobody-holds" },
  });
  const { requests } = await harness(() => ({ ok: true }), {
    early: [orphan],
  });
  await waitFor(
    () => requests().includes("terminate orphan"),
    "the orphaned transfer to be ended",
  );
});

it("an engine whose stores cannot be read answers as unavailable and refuses every change", async () => {
  const { engine, requests } = await harness(() => ({ ok: true }), {
    stores: Layer.succeed(
      MirrorHistoryStore.MirrorHistory,
      MirrorHistoryStore.MirrorHistory.of({
        load: Effect.die(new Error("the store is unreadable")),
        save: () => Effect.void,
      }),
    ),
  });
  assert.equal(
    succeeded(await engine((mirrors) => mirrors.status)),
    "unavailable",
  );
  assert.equal(
    refusalOf(await engine((mirrors) => mirrors.create(input))),
    "The mirror engine failed to start: the store is unreadable.",
  );
  assert.deepEqual(requests(), []);
});

it("an adopt and a project relocate carry a mirror's thread and its running session to the new id", async () => {
  // The engine's adopt and relocate run git in this process.
  scrubProcessGitEnv();
  const git = sandboxGit();
  const { engine, run, requests, state, history } = await harness((request) =>
    request.op === "create" ? { ok: true, session: "reopened" } : { ok: true },
  );
  const base = tempDir("sm-mirror-rekeys-", trackTest);
  const repo = join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "a");
  // An original mirrored from here, outside the repo, and a copy a peer
  // mirrors into, inside it, whose thread the relocate carries.
  const outside = join(base, "outside");
  git(repo, "worktree", "add", "-q", "-b", "otter", outside);
  const copy = join(repo, "nested", "owl");
  git(repo, "worktree", "add", "-q", "-b", "owl", copy);
  const project = await run(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({ name: "repo", path: repo }),
    ),
  );
  const original = worktreeIdFromPath(outside);
  succeeded(
    await engine((mirrors) =>
      Effect.sync(() => {
        mirrors.noteEvent(original, "started", "");
        mirrors.noteEvent(worktreeIdFromPath(repo), "started", "");
        mirrors.noteEvent(worktreeIdFromPath(copy), "started", "");
      }),
    ),
  );
  const live = rawMirrorSession({
    session: "live",
    localRoot: outside,
    localWorktreeId: original,
    labels: {
      [MIRROR_LABEL_MODE]: "mirror",
    },
  });
  await state([live]);

  const adopted = await run(
    Effect.gen(function* () {
      const worktrees = yield* Worktrees.Worktrees;
      const external = (yield* worktrees.identities(project)).find(
        (row) => row.path === outside,
      );
      assert.ok(external !== undefined);
      return (yield* worktrees.adopt(
        { project, worktree: external },
        { force: false },
        { report: () => Effect.void, color: false },
      )).worktree;
    }),
  );
  await waitFor(
    () => history(adopted.id).some((event) => event.kind === "started"),
    "the thread to follow the adopt",
  );
  assert.deepEqual(history(original), []);
  // The daemon's next snapshot, the session's root gone.
  await state([live]);
  await waitFor(
    () => requests().includes("terminate live"),
    "the session to re-open on the adopted checkout",
  );
  assert.deepEqual(requests(), ["pause live", "create", "terminate live"]);

  const moved = join(base, "repo-moved");
  renameSync(repo, moved);
  await run(
    Effect.gen(function* () {
      const listed = (yield* (yield* Registry.Registry).listed).find(
        ({ id }) => id === project.id,
      );
      assert.ok(listed !== undefined);
      yield* (yield* Worktrees.Worktrees).relocateProject(listed, moved);
    }),
  );
  const movedCopy = worktreeIdFromPath(join(moved, "nested", "owl"));
  await waitFor(
    () => history(movedCopy).some((event) => event.kind === "started"),
    "the copy's thread to follow the relocate",
  );
  assert.ok(
    history(worktreeIdFromPath(moved)).some(
      (event) => event.kind === "started",
    ),
    "the primary's thread stayed under its old id",
  );
});

it("a daemon restarting keeps the list and the follower's verdict, and the threads note nothing of it", async () => {
  const { run, state, crash, adjust, write, history } = await harness(() => ({
    ok: true,
  }));
  const mirror = rawMirrorSession({
    session: "s1",
    localRoot: root,
    localWorktreeId: "w1",
    labels: {
      [MIRROR_LABEL_MODE]: "mirror",
    },
    local: mirrorEndpoint({ connected: true }),
    remote: mirrorEndpoint({ connected: true }),
  });
  await state([mirror]);
  const before = await run(mirrorList());
  assert.deepEqual(
    before.sessions.map((listed) => listed.session),
    ["s1"],
  );
  await crash();
  const during = await run(mirrorList());
  assert.equal(during.daemon, "failing");
  assert.deepEqual(during.sessions, before.sessions);
  // The next run brings the session back still connecting.
  await adjust(1_000);
  await write({ event: "ready" });
  await state([
    {
      ...mirror,
      local: mirrorEndpoint({ connected: false }),
      remote: mirrorEndpoint({ connected: false }),
    },
  ]);
  await state([mirror]);
  assert.deepEqual(
    history("w1").filter(
      (event) => event.kind === "disconnected" || event.kind === "connected",
    ),
    [],
  );
});

it("a thread says a lost link and its return, never the cut stream's error, and an error from before stands until the link is back, while the sync's own error, which leaves the link down too, is noted", async () => {
  const { state, history } = await harness(() => ({ ok: true }));
  const at = (
    connected: boolean,
    fields: Partial<Parameters<typeof rawMirrorSession>[0]> = {},
  ) =>
    rawMirrorSession({
      session: "s1",
      localRoot: root,
      localWorktreeId: "w-link",
      labels: { [MIRROR_LABEL_MODE]: "mirror" },
      status: connected ? "watching" : "connecting-remote",
      local: mirrorEndpoint({ connected: true }),
      remote: mirrorEndpoint({ connected }),
      ...fields,
    });
  // The link's rows and the engine's errors: the git follower, which has
  // no project to read here, notes its own.
  const kinds = () =>
    history("w-link")
      .map((event) => event.kind)
      .filter((kind) => !kind.startsWith("git-"));
  // Mutagen's words as a stream is cut (the peer away, or a switch of
  // its turned off): the sync fails with both ends reset to down.
  const cut =
    "beta polling error: unable to receive poll response: unable to read message length: EOF";
  await state([at(true)]);
  // A cut on a request going out, and on a file copy coming in, going
  // out, and flushed at its end.
  for (const lastError of [
    cut,
    "beta scan error: unable to send scan request: message transmission failed: write tcp 127.0.0.1:52011->127.0.0.1:52010: write: broken pipe",
    "unable to stage files on alpha: unable to decode and forward rsync operations: unable to decode transmission: unable to read message length: unexpected EOF",
    "unable to stage files on beta: unable to transmit delta: unable to encode transmission: unable to write message: write tcp 127.0.0.1:52011->127.0.0.1:52010: write: broken pipe",
    "unable to stage files on beta: unable to finalize receiver: unable to finalize encoder: unable to flush encoded messages: write tcp 127.0.0.1:52011->127.0.0.1:52010: write: broken pipe",
  ]) {
    await state([at(false, { lastError })]);
  }
  await state([at(true)]);
  assert.deepEqual(kinds(), ["connected", "disconnected"]);
  await state([at(true, { lastError: "alpha scan error: a scan failed" })]);
  await state([at(false, { lastError: cut })]);
  await state([at(true)]);
  // Newest first.
  assert.deepEqual(kinds(), [
    "recovered",
    "connected",
    "disconnected",
    "error",
    "connected",
    "disconnected",
  ]);
  // The link back, its error not cleared yet by the sync's start.
  await state([at(false, { lastError: cut })]);
  await state([at(true, { lastError: cut })]);
  await state([
    at(false, {
      lastError:
        "unable to save ancestor: unable to write message data: unable to write data to temporary file: write /data/archives/.mutagen-temporary-atomic-write123: no space left on device",
    }),
  ]);
  // The codec's own failure under a cut's words: a snapshot too big.
  await state([
    at(false, {
      lastError:
        "beta scan error: unable to receive scan response: message size too large",
    }),
  ]);
  assert.deepEqual(kinds().slice(0, 6), [
    "error",
    "error",
    "disconnected",
    "connected",
    "disconnected",
    "recovered",
  ]);
});

it("a thread notes git agreeing again across a spell of git off, which says nothing of the git state", () => {
  const history = createMirrorHistory({
    store: { load: () => ({}), save: () => {} },
  });
  const raw = rawMirrorSession({
    session: "s1",
    localRoot: root,
    localWorktreeId: "w-git",
    labels: { [MIRROR_LABEL_MODE]: "mirror" },
  });
  for (const status of ["synced", "diverged", "off", "synced"] as const) {
    history.observe([raw], () => ({ status, detail: "" }));
  }
  assert.deepEqual(
    history.eventsFor("w-git").map((event) => event.kind),
    ["git-synced", "git-diverged"],
  );
});

it("a peer coming to take this device's calls reconnects its sessions waiting on the link at once and side by side, none paused, halted or held by a re-open and no other device's, and git looks at its sessions again", async () => {
  const admissions = Effect.runSync(PubSub.unbounded<string>());
  const asked: string[] = [];
  standInPeers({
    transportFor: (deviceId) => ({
      invoke: (channel) => {
        if (channel === "mirror:gitState") asked.push(deviceId);
        return Promise.reject(new Error("not in this check"));
      },
      subscribe: () => () => {},
    }),
    channelsFor: () => () => Promise.reject(new Error("not in this check")),
    admissions: Stream.fromPubSub(admissions),
  });
  const project = await Effect.runPromiseWith(await hostContext())(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({
        name: "admitted",
        path: mkdtempSync(join(tmpdir(), "sm-mirror-admitted-")),
      }),
    ),
  );
  // A resume waits on its reconnect, and a re-open's pause on the
  // daemon: both are held until the check ends.
  let holding = true;
  const { state, requests, fork, held, answerHeld } = await harness((request) =>
    holding && (request.op === "resume" || request.op === "pause")
      ? null
      : { ok: true, ...(request.op === "create" ? { session: "new" } : {}) },
  );
  // Before the engine's teardown, which waits on them.
  trackTest(async () => {
    holding = false;
    for (const request of held.splice(0)) {
      await answerHeld(request, { ok: true });
    }
  });
  const into = (
    id: string,
    deviceId: string,
    fields: Partial<Parameters<typeof rawMirrorSession>[0]>,
  ) =>
    rawMirrorSession({
      session: id,
      localRoot: root,
      deviceId,
      labels: {
        [MIRROR_LABEL_MODE]: "mirror",
        [MIRROR_LABEL_LOCAL_PROJECT]: project.id,
      },
      ...fields,
    });
  await state([
    into("lost", "B", { status: "disconnected" }),
    into("dialing", "B", { status: "connecting-remote" }),
    into("held", "B", { status: "disconnected", paused: true }),
    into("halted", "B", { status: "halted-on-root-emptied" }),
    into("live", "B", { status: "watching" }),
    into("elsewhere", "C", { status: "disconnected" }),
    into("reopening", "B", { status: "disconnected" }),
  ]);
  await waitFor(() => asked.length === 6, "git to look at the sessions");
  fork((mirrors) => mirrors.recreate("reopening", input));
  await waitFor(
    () => requests().includes("pause reopening"),
    "the re-open to pause its session",
  );
  asked.length = 0;
  PubSub.publishUnsafe(admissions, "B");
  const resumed = () =>
    requests()
      .filter((request) => request.startsWith("resume"))
      .sort();
  // Side by side: neither resume has an answer yet.
  await waitFor(
    () => resumed().length >= 2 && asked.length >= 5,
    "the sessions to reconnect and git to look again",
  );
  // Any third resume would be in by now.
  await settleTurns();
  assert.deepEqual(resumed(), ["resume dialing", "resume lost"]);
  assert.deepEqual(asked, ["B", "B", "B", "B", "B"]);
});

// A hub status with each peer a direct session is up with, by its two
// switches as reported.
const hubStatus = (
  peers: Record<string, { control?: boolean; sharing?: boolean }>,
) => {
  const reported = (key: "control" | "sharing") =>
    Object.fromEntries(
      Object.entries(peers).flatMap(([peer, switches]) =>
        switches[key] === undefined ? [] : [[peer, switches[key]]],
      ),
    );
  return {
    peerAppVersions: Object.fromEntries(
      Object.keys(peers).map((peer) => [peer, "3.0.0"]),
    ),
    peerAcceptsCommands: reported("control"),
    peerSharesData: reported("sharing"),
  };
};

it("the hub's status snapshots admit a peer as its direct session is up with both of its switches on, once, and again after it left", async () => {
  const admissions = Effect.runSync(PeerReach.makeAdmissions);
  const heard: string[] = [];
  const listening = Effect.runFork(
    admissions.admissions.pipe(
      Stream.runForEach((peer) => Effect.sync(() => heard.push(peer))),
    ),
  );
  trackTest(() => Effect.runPromise(Fiber.interrupt(listening)));
  await settleTurns();
  const both = { control: true, sharing: true };
  admissions.note(
    hubStatus({
      B: both,
      C: { control: false, sharing: true },
      D: { control: true },
    }),
  );
  admissions.note(hubStatus({ B: both, C: both }));
  // B's link drops, then comes back with its sharing off, then on.
  admissions.note(hubStatus({ C: both }));
  admissions.note(hubStatus({ B: { control: true, sharing: false }, C: both }));
  admissions.note(hubStatus({ B: both, C: both }));
  await waitFor(() => heard.length === 3, "the admissions");
  await settleTurns();
  assert.deepEqual(heard, ["B", "C", "B"]);
});

it("a stepped wall clock neither holds a copy-gone report back nor lets one through early", async () => {
  standInPeers({
    transportFor: () => ({
      invoke: (channel) =>
        Promise.reject(
          channel === "mirror:gitState"
            ? new UnknownWorktreeError({ worktreeId: "copy" })
            : new Error("not in this check"),
        ),
      subscribe: () => () => {},
    }),
    channelsFor: () => () => Promise.reject(new Error("not in this check")),
  });
  const project = await Effect.runPromiseWith(await hostContext())(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({ name: "gone", path: root }),
    ),
  );
  const copy = rawMirrorSession({
    session: "s1",
    localRoot: root,
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
  const clocks = sleepingClock(clock);
  let reports = 0;
  const scope = Effect.runSync(Scope.make());
  trackTest(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const follower = await Effect.runPromiseWith(await hostContext())(
    makeGitFollower({
      sessions: Effect.succeed([copy]),
      sweepMs: 3_600_000,
      onCopyGone: () => {
        reports += 1;
      },
      log: () => {},
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(Clock.Clock, clocks.wall),
    ),
  );
  await waitFor(() => reports === 1, "the first report");
  // Back an hour, a minute on.
  clocks.sleep(-3_600_000);
  await clock.advance(60_000);
  await Effect.runPromise(follower.reconcileNow("s1"));
  assert.equal(reports, 2, "a wall clock stepped back held the report off");
  // Forward two hours, a second on.
  clocks.sleep(7_200_000);
  await clock.advance(1_000);
  await Effect.runPromise(follower.reconcileNow("s1"));
  assert.equal(reports, 2, "a wall clock stepped forward let one through");
});

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

it("an orphaned transfer whose end failed is asked again on the next snapshot", async () => {
  let terminates = 0;
  const { state, requests } = await harness((request) => {
    if (request.op !== "terminate") return { ok: true };
    terminates += 1;
    return terminates === 1
      ? { ok: false, error: "the engine is busy" }
      : { ok: true };
  });
  const orphan = rawMirrorSession({
    session: "orphan",
    localRoot: root,
    labels: { [MIRROR_LABEL_MODE]: "transfer-a-token-nobody-holds" },
  });
  await state([orphan]);
  await waitFor(() => terminates === 1, "the orphan's first end");
  await state([orphan]);
  await waitFor(
    () =>
      requests().filter((asked) => asked === "terminate orphan").length === 2,
    "the orphan's end to be asked again",
  );
});

it("a transfer whose daemon stops and doesn't come back fails at the missing ceiling", async () => {
  const clock = testClock();
  let status: "running" | "failing" = "running";
  const engine = inertMirrorImpl({
    status: Effect.sync(() => status),
    create: () => Effect.succeed("t1"),
    terminate: () => Effect.void,
    // The snapshot that stands through the stop: connected, mid-copy.
    sessions: Effect.succeed([
      rawMirrorSession({ session: "t1", status: "reconciling" }),
    ]),
  });
  let outcome: unknown;
  Effect.runForkWith(clock.context)(
    transferFilesOnce(
      {
        localRoot: root,
        localWorktreeId: "w",
        sourceDeviceId: "B",
        sourceProjectId: "p",
        sourceWorktreeId: "w",
        remoteRoot: "/b",
        name: "w",
        ignores: [],
      },
      () => {},
    ).pipe(
      Effect.provideService(MirrorEngine, engine),
      Effect.tap((result) =>
        Effect.sync(() => {
          outcome = result;
        }),
      ),
    ),
  );
  await clock.advance(1_000);
  status = "failing";
  for (let second = 0; second < 12; second++) await clock.advance(1_000);
  assert.deepEqual(outcome, {
    crossed: false,
    conflicts: 0,
    error: "the transfer session was lost with the engine",
  });
});

it("the bookkeeping waits for a restarted daemon's own snapshot", async () => {
  const { state, crash, adjust, write, requests } = await harness(() => ({
    ok: true,
  }));
  const gone = join(root, "gone");
  mkdirSync(gone, { recursive: true });
  const mirror = rawMirrorSession({
    session: "s1",
    localRoot: gone,
    localWorktreeId: "w1",
    labels: {
      [MIRROR_LABEL_MODE]: "mirror",
    },
  });
  await state([mirror]);
  await crash();
  rmSync(gone, { recursive: true, force: true });
  await adjust(1_000);
  await write({ event: "ready" });
  await settleTurns();
  assert.deepEqual(
    requests().filter((asked) => asked.startsWith("terminate")),
    [],
    "the last run's snapshot ended a session",
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
  // The daemon's next snapshot, which says so.
  await mirror.state([raw(true)]);
  return {
    ...mirror,
    project,
    original,
    moved,
    raw,
    reach: () => {
      reached = true;
      PubSub.publishUnsafe(admissions, "B");
    },
  };
}

it("a moved original keeps its mirror across a start with the peer reached late: the re-open waits, its session paused, for the peer to take this device's calls", async () => {
  const { requests, reach, history, moved } =
    await movedOriginalWithPeerAway("late");
  assert.deepEqual(requests(), ["pause late"]);
  reach();
  await waitFor(
    () => requests().includes("terminate late"),
    "the mirror to re-open on the moved original",
  );
  // Never resumed on the old folder: the re-open pauses it again, and
  // ends it once the new session is up.
  assert.deepEqual(requests(), [
    "pause late",
    "pause late",
    "create",
    "terminate late",
  ]);
  const kinds = history(moved.id).map((event) => event.kind);
  assert.ok(kinds.includes("resumed"), `the thread says ${kinds.join(", ")}`);
  assert.ok(!kinds.includes("stopped"), `the thread says ${kinds.join(", ")}`);
});

it("a moved original's mirror waiting on its peer ends, its copy kept, when a worktree is made at the old folder, never mirroring that one", async () => {
  const { requests, history, engine, project, original, moved } =
    await movedOriginalWithPeerAway("taken");
  // A note on the old id's thread during the wait, which the end
  // carries to the worktree the original became.
  await engine((mirrors) =>
    Effect.sync(() =>
      mirrors.noteEvent(original.id, "paused", "noted during the wait"),
    ),
  );
  const made = await Effect.runPromiseWith(await hostContext())(
    Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
      worktrees.create(
        project,
        { name: "otter-taken", branch: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      ),
    ),
  );
  // The old folder's id, as ids are path derived.
  assert.equal(made.worktree.id, original.id);
  await waitFor(
    () => requests().includes("terminate taken"),
    "the waiting mirror to end",
  );
  assert.deepEqual(requests(), ["pause taken", "terminate taken"]);
  const stopped = history(moved.id).find((event) => event.kind === "stopped");
  assert.match(stopped?.detail ?? "", /took its old folder/);
  // The thread went with the worktree, not to the one at its old folder.
  assert.ok(
    history(moved.id).some(({ detail }) => detail === "noted during the wait"),
  );
  assert.deepEqual(history(original.id), []);
});

it("a moved original's mirror whose peer comes past 2 minutes of waiting ends, its copy kept, never re-opening on what drifted apart meanwhile", async () => {
  const { requests, reach, adjust, history, moved } =
    await movedOriginalWithPeerAway("past");
  await adjust(2 * 60_000 + 1);
  reach();
  await waitFor(
    () => requests().includes("terminate past"),
    "the waiting mirror to end",
  );
  assert.deepEqual(requests(), ["pause past", "terminate past"]);
  const stopped = history(moved.id).find((event) => event.kind === "stopped");
  assert.match(stopped?.detail ?? "", /wasn't reached within 2 minutes/);
});

it("a moved original's mirror waiting on its peer ends, its copy kept, when the worktree it became is mirrored meanwhile, never giving it a second mirror", async () => {
  const { requests, state, reach, history, moved, raw } =
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
  const stopped = history(moved.id).find((event) => event.kind === "stopped");
  assert.match(stopped?.detail ?? "", /mirrored again/);
});
