// Durable proof for how the mirror daemon's supervisor
// (main/core/mirror/daemon.ts) reads the engine's NDJSON lines
// (file-sync/engine.go, the daemon control protocol) and restarts it.
// The child is a fake the proof writes the daemon's side of and ends
// when it likes, so each line is exactly the one under test, no engine
// built, and the clock is a TestClock.
//
// Asserts:
//   - a well-formed state line replaces the sessions, and a response
//     settles the request it names,
//   - a state line that breaks the contract (a field missing, a
//     sessions list that is not one) is dropped and logged, the last
//     good snapshot standing and the bridge reading the next line,
//   - a repeat of the same rejection logs once, the responses in
//     between not resetting it, and a good line of its kind does,
//   - a key the protocol does not name, on a line or on a session, is
//     stripped and the line read, and an event it does not name is
//     ignored, so what a newer engine adds cannot stop the stream or
//     fail a request,
//   - a malformed response settles its request with an error rather
//     than resolving with what it carried,
//   - the engine's id-less refusal (an empty id) is logged, not dropped,
//   - a child that exits is spawned again on the restart ladder, and
//     one that ran past the stable window restarts from its bottom.
//
// Run: pnpm test mirror-daemon-lines.
import assert from "node:assert/strict";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as FileSync from "@host/fileSync/FileSync";
import * as MirrorDaemon from "../main/core/mirror/daemon.ts";
import { it } from "vitest";
import { trackTest } from "./lib/vitestKit.mts";

const endpoint = {
  connected: true,
  scanned: true,
  directories: 1,
  files: 2,
  symbolicLinks: 0,
  totalFileSize: 10,
  problems: [],
  excludedProblems: 0,
};

// One session the way mirrorSessionStateOf writes it.
function session(id: string) {
  return {
    session: id,
    name: "mirror-w",
    labels: { localProjectId: "p", localWorktreeId: "w" },
    localRoot: "/a",
    deviceId: "B",
    projectId: "p",
    worktreeId: "w",
    remoteRoot: "/b",
    paused: false,
    ignores: [],
    createdAt: 1,
    status: "watching",
    statusText: "Watching for changes",
    successfulCycles: 3,
    conflicts: [],
    excludedConflicts: 0,
    local: endpoint,
    remote: endpoint,
  };
}

const onDaemon = <A, E>(
  f: (daemon: MirrorDaemon.MirrorDaemon["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* MirrorDaemon.MirrorDaemon);
  });

// Lets the supervisor read a line, and a request write its own: a few
// turns of the event loop.
const settle = () =>
  [1, 2, 3, 4, 5].reduce<Promise<void>>(
    (turns) =>
      turns.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );

// A daemon on a fake child: `send` writes a line from the engine's
// side, `requests` collects what the supervisor wrote to it.
async function harness() {
  const requests: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const out = Effect.runSync(Queue.unbounded<Uint8Array>());
  // One per spawn: the child's exit, which the proof decides.
  const exits: Deferred.Deferred<number>[] = [];
  const fakeFileSync = Layer.succeed(
    FileSync.FileSync,
    FileSync.FileSync.of({
      spawn: (_args, { stdin }) =>
        Effect.gen(function* () {
          yield* stdin.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => requests.push(JSON.parse(line))),
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
            kill: () => Effect.void,
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
  const captured = Logger.make(({ message }) => {
    logs.push(Array.isArray(message) ? message.join(" ") : String(message));
  });
  const runtime = ManagedRuntime.make(
    MirrorDaemon.layer({
      gatewayAddress: () => "127.0.0.1:1",
      gatewayToken: () => "token",
      dataDir: () => "unused",
    }).pipe(
      Layer.provide(fakeFileSync),
      Layer.provide(Logger.layer([captured])),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  trackTest(() => runtime.dispose());
  await runtime.context();
  const daemon = {
    status: () => runtime.runSync(onDaemon((d) => d.status)),
    sessions: () => runtime.runSync(onDaemon((d) => d.sessions)),
    pause: (id: string) => runtime.runPromise(onDaemon((d) => d.pause(id))),
    resume: (id: string) => runtime.runPromise(onDaemon((d) => d.resume(id))),
  };
  await settle();
  const send = async (line: unknown) => {
    Queue.offerUnsafe(
      out,
      new TextEncoder().encode(JSON.stringify(line) + "\n"),
    );
    await settle();
  };
  // Moves the daemon's clock on, then lets it act on the time.
  const adjust = async (ms: number) => {
    await runtime.runPromise(TestClock.adjust(ms));
    await settle();
  };
  const exit = async (index: number) => {
    const deferred = exits[index];
    assert.ok(deferred !== undefined, `no child ${index} was spawned`);
    Effect.runSync(Deferred.succeed(deferred, 1));
    await settle();
  };
  return { daemon, send, requests, logs, exits, adjust, exit };
}

it("a well-formed state line is the sessions", async () => {
  const { daemon, send } = await harness();
  await send({ event: "ready" });
  assert.equal(daemon.status(), "running");
  await send({ event: "state", sessions: [session("s1")] });
  assert.deepEqual(
    daemon.sessions().map((raw) => raw.session),
    ["s1"],
  );
});

it("a state line off the contract is dropped and logged", async () => {
  const { daemon, send, logs } = await harness();
  await send({ event: "ready" });
  await send({ event: "state", sessions: [session("s1")] });
  const { labels: _labels, ...unlabelled } = session("s2");
  await send({ event: "state", sessions: [unlabelled] });
  assert.deepEqual(
    daemon.sessions().map((raw) => raw.session),
    ["s1"],
    "a session without labels replaced the snapshot",
  );
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.match(logs[0] ?? "", /labels/);
  await send({ event: "state", sessions: "s2" });
  assert.deepEqual(
    daemon.sessions().map((raw) => raw.session),
    ["s1"],
    "a sessions field that is not a list emptied the snapshot",
  );
  await send({ event: "state", sessions: [session("s3")] });
  assert.deepEqual(
    daemon.sessions().map((raw) => raw.session),
    ["s3"],
    "the bridge stopped reading after a bad line",
  );
});

it("a repeated rejection logs once", async () => {
  const { daemon, send, requests, logs } = await harness();
  await send({ event: "ready" });
  const bad = { event: "state", sessions: [{ ...session("s1"), status: 7 }] };
  await send(bad);
  const paused = daemon.pause("s1");
  await settle();
  await send({ id: requests.at(-1)?.["id"], ok: true, session: "s1" });
  await paused;
  await send(bad);
  assert.equal(logs.length, 1, logs.join("\n"));
  await send({ event: "state", sessions: [] });
  await send(bad);
  assert.equal(logs.length, 2, "a rejection after a good line logs again");
});

it("what the protocol does not name is stripped or ignored, not refused", async () => {
  const { daemon, send, requests, logs } = await harness();
  await send({ event: "ready", version: 2 });
  assert.equal(daemon.status(), "running");
  await send({
    event: "state",
    sessions: [{ ...session("s1"), newField: true }],
    index: 9,
  });
  assert.deepEqual(
    daemon.sessions().map((raw) => raw.session),
    ["s1"],
  );
  assert.equal("newField" in (daemon.sessions()[0] ?? {}), false);
  const paused = daemon.pause("s1");
  await settle();
  await send({
    id: requests.at(-1)?.["id"],
    ok: true,
    session: "s1",
    took: 3,
  });
  assert.equal(await paused, "s1");
  await send({ event: "progress", session: "s1", files: 3 });
  assert.deepEqual(
    daemon.sessions().map((raw) => raw.session),
    ["s1"],
  );
  assert.deepEqual(logs, []);
});

it("a response settles its request, a malformed one with an error", async () => {
  const { daemon, send, requests, logs } = await harness();
  await send({ event: "ready" });
  const good = daemon.pause("s1");
  await settle();
  await send({ id: requests.at(-1)?.["id"], ok: true, session: "s1" });
  assert.equal(await good, "s1");
  const bad = assert.rejects(daemon.resume("s1"), /malformed/);
  await settle();
  await send({ id: requests.at(-1)?.["id"], ok: true, session: 42 });
  await bad;
  assert.equal(logs.length, 1, logs.join("\n"));
});

it("an id-less refusal is logged", async () => {
  const { send, logs } = await harness();
  await send({ event: "ready" });
  await send({ id: "", ok: false, error: "malformed request: x" });
  assert.equal(logs.length, 1, "the refusal went unreported");
  assert.match(logs[0] ?? "", /malformed request: x/);
});

it("a daemon that exits is restarted on the ladder, from its bottom after a long run", async () => {
  const { daemon, send, exits, adjust, exit } = await harness();
  await send({ event: "ready" });
  assert.equal(daemon.status(), "running");
  await exit(0);
  assert.equal(daemon.status(), "starting");
  await adjust(999);
  assert.equal(exits.length, 1, "restarted before the first rung");
  await adjust(1);
  assert.equal(exits.length, 2, "not restarted on the first rung");
  await exit(1);
  await adjust(1_999);
  assert.equal(exits.length, 2, "restarted before the second rung");
  await adjust(1);
  assert.equal(exits.length, 3, "not restarted on the second rung");
  // Up past the stable window: the streak is over.
  await adjust(30_000);
  await exit(2);
  await adjust(1_000);
  assert.equal(exits.length, 4, "a long run did not reset the ladder");
});
