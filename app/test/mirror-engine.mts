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
//   - a device leaving its account ends its sessions within the
//     sweep's bound: a terminate the daemon never answers is given up
//     at 5 s, and an answer that comes later notes nothing on the
//     thread, since the sweep did not go on running.
//
// Run: pnpm test mirror-engine.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { it } from "vitest";
import * as FileSync from "../host/fileSync/FileSync.ts";
import * as HostAccount from "../host/lib/HostAccount.ts";
import * as MirrorDaemon from "../host/mirror/MirrorDaemon.ts";
import {
  type MirrorCreateInput,
  MirrorEngine,
  MirrorError,
} from "../host/mirror/MirrorEngine.ts";
import * as MirrorEngineLayer from "../host/mirror/MirrorEngineLayer.ts";
import * as MirrorGateway from "../host/mirror/MirrorGateway.ts";
import { MIRROR_LABEL_LOCAL_WORKTREE } from "../host/mirror/registry.ts";
import { settleTurns } from "./lib/checkKit.mts";
import { hostContext } from "./lib/hostRuntime.mts";
import { rawMirrorSession } from "./lib/mirrorFakes.mts";
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
    labels:
      worktreeId === "" ? {} : { [MIRROR_LABEL_LOCAL_WORKTREE]: worktreeId },
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
// `answer` says, or holds it while `answer` says null.
async function harness(answer: (request: Request) => Answer | null) {
  const requests: Request[] = [];
  const held: Request[] = [];
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
  const runtime = ManagedRuntime.make(
    MirrorEngineLayer.layer({
      onChange: () => {},
      projectChanged: () => {},
    }).pipe(
      Layer.provideMerge(MirrorDaemon.layer({ dataDir: () => "unused" })),
      Layer.provide(Layer.mergeAll(fakeFileSync, gateway)),
      Layer.provideMerge(HostAccount.layer),
      Layer.provideMerge(TestClock.layer()),
      Layer.provide(Layer.succeedContext(await hostContext())),
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
  const engine = <A, E>(
    f: (engine: MirrorEngine["Service"]) => Effect.Effect<A, E>,
  ) => runtime.runPromiseExit(Effect.flatMap(MirrorEngine, f));
  return {
    engine,
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
