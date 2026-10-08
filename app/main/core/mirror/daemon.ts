// Supervises this device's `file-sync daemon` (file-sync/engine.go): the
// long-lived Mutagen session manager behind continuous worktree
// mirroring. One child for the app's whole life, spoken to over its
// stdin/stdout in NDJSON: requests carry an id the response echoes,
// and the daemon streams a full state snapshot every time any session
// moves. A crash is met with a restart on a short ladder (persisted
// sessions come back on their own when it does), and closing the layer
// ends the child. The engine never outlives this process: besides the
// layer's close, it exits when its stdin closes and on seeing its
// parent pid change (file-sync/main.go, watchParent), so a host that
// dies uncleanly takes its daemon and every serve child down with it.
//
// Electron-free on purpose: the binary comes through the FileSync
// service, so the mirror check drives this exact supervisor against a
// freshly built engine.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as FileSync from "@host/fileSync/FileSync";
import type { MirrorCreateInput } from "@host/ipc/modules/mirror";
import * as PromiseAdapter from "@host/lib/util/promiseAdapter";
import {
  mirrorEngineBlocker,
  type MirrorDaemonStatus,
  type MirrorSessionRaw,
  MirrorSessionRawSchema,
} from "@shigomori/contracts/modules/mirror";
import { BACKOFF_LADDER_MS } from "@shared/remote/supervisor";
import { restartSchedule } from "@shared/remote/restartSchedule";
import { MIRROR_GATEWAY_TOKEN_ENV } from "./gateway";

// A request the daemon did not answer with its session. `detail` is the
// engine's own refusal, or why the engine cannot take requests, both
// words a person reads.
export class MirrorDaemonError extends Schema.TaggedError<MirrorDaemonError>()(
  "MirrorDaemonError",
  {
    op: Schema.String,
    reason: Schema.Literals([
      "not-running",
      "exited",
      "stopped",
      "timed-out",
      "malformed",
      "refused",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-running":
        return this.detail ?? "The mirror daemon is not running yet.";
      case "exited":
        return "mirror daemon exited";
      case "stopped":
        return "mirror daemon stopped";
      case "timed-out":
        return `mirror ${this.op} timed out`;
      case "malformed":
        return "mirror daemon sent a malformed response";
      case "refused":
        return this.detail ?? `mirror ${this.op} failed`;
    }
  }
}

// The lines the daemon writes (file-sync/engine.go, the daemon control
// protocol): an event, or a response echoing its request's id. Each is
// read against its schema, and one that breaks it is dropped and
// logged: the bridge keeps reading, the last state snapshot stands,
// and a request the line named is answered with the error. What a
// newer engine may add is let through: an event this build does not
// know is ignored, and a top-level key the schema does not name, on a
// line or on a session, is stripped. The nested shapes (endpoint,
// staging, conflict, problem, change) are the IPC contract's strict
// ones, so a field added inside them still drops the line.
const DaemonEventSchema = Schema.Union([
  Schema.Struct({ event: Schema.Literal("ready") }),
  Schema.Struct({
    event: Schema.Literal("state"),
    sessions: Schema.Array(MirrorSessionRawSchema),
  }),
  Schema.Struct({ event: Schema.Literal("error"), error: Schema.String }),
]);
type DaemonEvent = typeof DaemonEventSchema.Type;
const decodeDaemonEvent = Schema.decodeUnknownResult(DaemonEventSchema);
const KNOWN_EVENTS: ReadonlySet<string> = new Set(
  DaemonEventSchema.members.map((member) => member.fields.event.literal),
);

const DaemonResponseSchema = Schema.Struct({
  id: Schema.String,
  ok: Schema.Boolean,
  session: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
type DaemonResponse = typeof DaemonResponseSchema.Type;
const decodeDaemonResponse = Schema.decodeUnknownResult(DaemonResponseSchema);

// Restart ladder after an unexpected exit: the house backoff plus a
// slow top rung, so a daemon that keeps dying (a broken build, a
// locked data directory) settles into a slow retry instead of a hot
// loop, while one that ran long enough to be healthy restarts from
// the bottom.
const RESTART_LADDER_MS: readonly [number, ...number[]] = [
  ...BACKOFF_LADDER_MS,
  30_000,
];
// A create blocks on two endpoint connects (the peer side spawns a
// process and Mutagen handshakes), so requests get a generous ceiling.
const REQUEST_TIMEOUT_MS = 120_000;

export class MirrorDaemon extends Context.Service<
  MirrorDaemon,
  {
    readonly status: Effect.Effect<MirrorDaemonStatus>;
    readonly sessions: Effect.Effect<readonly MirrorSessionRaw[]>;
    readonly create: (
      input: MirrorCreateInput,
    ) => Effect.Effect<string, MirrorDaemonError>;
    readonly terminate: (
      session: string,
    ) => Effect.Effect<string, MirrorDaemonError>;
    readonly pause: (
      session: string,
    ) => Effect.Effect<string, MirrorDaemonError>;
    readonly resume: (
      session: string,
    ) => Effect.Effect<string, MirrorDaemonError>;
  }
>()("sm/host/MirrorDaemon") {}

export interface Options {
  // The gateway address the daemon dials peers through, read at each
  // spawn (throwing when the gateway is not listening yet, which puts
  // the daemon on the restart ladder until it is).
  readonly gatewayAddress: () => string;
  // The gateway's per-bind token, passed through the environment and
  // read at each spawn, so a rebound gateway's daemon carries the
  // token that gateway accepts.
  readonly gatewayToken: () => string;
  // Where the engine persists sessions (a directory under the host's
  // data dir), read at each spawn.
  readonly dataDir: () => string;
  // Fires on every state snapshot and every status transition.
  readonly onChange?: () => void;
}

const encoder = new TextEncoder();

const make = (options: Options) =>
  Effect.gen(function* () {
    const fileSync = yield* FileSync.FileSync;
    const status = yield* Ref.make<MirrorDaemonStatus>("stopped");
    const sessions = yield* Ref.make<readonly MirrorSessionRaw[]>([]);
    // The running child's stdin, for the requests.
    const stdin = yield* Ref.make(Option.none<Queue.Queue<Uint8Array>>());
    // The requests waiting on a response, by id. One fiber at a time
    // touches it, as everything here runs on the main thread.
    const pending = new Map<
      string,
      {
        readonly op: string;
        readonly response: Deferred.Deferred<DaemonResponse, MirrorDaemonError>;
      }
    >();
    let nextRequestId = 1;

    // The owner's listener runs the app's bookkeeping. One that throws
    // is logged, never taken for the daemon failing.
    const changed = Effect.try(() => options.onChange?.()).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `[mirror] a daemon change listener failed: ${errorMessageOf(error)}`,
        ),
      ),
    );

    const setStatus = (next: MirrorDaemonStatus) =>
      Ref.getAndSet(status, next).pipe(
        Effect.flatMap((previous) =>
          previous === next ? Effect.void : changed,
        ),
      );

    const failAllPending = (reason: "exited" | "stopped") =>
      Effect.forEach(
        [...pending],
        ([id, { op, response }]) => {
          pending.delete(id);
          return Deferred.fail(response, new MirrorDaemonError({ op, reason }));
        },
        { discard: true },
      );

    // The last rejection logged per kind of line (an event's name, or
    // "response"), so a daemon that keeps writing the same bad line
    // (every snapshot, once the contract has drifted) logs it once until
    // a line of that kind reads again. The requests in between do not
    // count.
    const lastRejection = new Map<string, string>();

    const rejectLine = (kind: string, line: string, reason: string) =>
      Effect.suspend(() => {
        if (lastRejection.get(kind) === reason) return Effect.void;
        lastRejection.set(kind, reason);
        return Effect.logWarning(
          `[mirror] daemon line dropped, off the protocol: ${reason}: ${line.slice(0, 200)}`,
        );
      });

    const handleEvent = (event: DaemonEvent) => {
      switch (event.event) {
        case "ready":
          return setStatus("running");
        case "state":
          return Ref.set(sessions, event.sessions).pipe(
            Effect.andThen(changed),
          );
        case "error":
          return Effect.logWarning(`[mirror] daemon error: ${event.error}`);
      }
    };

    const handleResponse = (response: DaemonResponse) => {
      // mirrorResponse always writes its id, so a request the daemon
      // could not read comes back with an empty one. Nothing to match.
      if (response.id === "") {
        return Effect.logWarning(
          `[mirror] daemon refused a request: ${response.error ?? "unknown"}`,
        );
      }
      const waiting = pending.get(response.id);
      return waiting === undefined
        ? Effect.void
        : Deferred.succeed(waiting.response, response);
    };

    const handleLine = (line: string) =>
      Effect.suspend(() => {
        let doc: unknown;
        try {
          doc = JSON.parse(line);
        } catch {
          return Effect.logWarning(
            `[mirror] daemon emitted a non-JSON line: ${line.slice(0, 200)}`,
          );
        }
        if (typeof doc !== "object" || doc === null) {
          return rejectLine("other", line, "not an object");
        }
        if (
          "event" in doc &&
          typeof doc.event === "string" &&
          !KNOWN_EVENTS.has(doc.event)
        ) {
          return Effect.void;
        }
        const kind = "event" in doc ? String(doc.event) : "response";
        const parsed: Result.Result<
          DaemonEvent | DaemonResponse,
          Schema.SchemaError
        > = "event" in doc ? decodeDaemonEvent(doc) : decodeDaemonResponse(doc);
        if (Result.isFailure(parsed)) {
          const reason = parsed.failure.message.replaceAll("\n", " ");
          // A request the line names is answered now, not at the timeout.
          const waiting =
            "id" in doc && typeof doc.id === "string"
              ? pending.get(doc.id)
              : undefined;
          return rejectLine(kind, line, reason).pipe(
            Effect.andThen(
              waiting === undefined
                ? Effect.void
                : Deferred.fail(
                    waiting.response,
                    new MirrorDaemonError({
                      op: waiting.op,
                      reason: "malformed",
                    }),
                  ),
            ),
          );
        }
        lastRejection.delete(kind);
        return "event" in parsed.success
          ? handleEvent(parsed.success)
          : handleResponse(parsed.success);
      });

    // One life of the child, from its spawn to its exit. Answers how
    // long it ran, which the restart ladder reads.
    const runOnce = Effect.gen(function* () {
      // The gateway binds on its own retry schedule. Until it has, the
      // daemon has nothing to dial and waits, which is not the engine
      // being missing.
      const gateway = yield* Effect.try(() => options.gatewayAddress()).pipe(
        Effect.option,
      );
      if (Option.isNone(gateway)) {
        yield* Effect.logWarning(
          "[mirror] daemon waiting for the gateway: mirror gateway is not listening",
        );
        yield* setStatus("starting");
        return;
      }
      const input = yield* Queue.unbounded<Uint8Array>();
      const spawned = yield* Effect.try(() => ({
        args: [
          "daemon",
          "--gateway",
          gateway.value,
          "--data-dir",
          options.dataDir(),
        ],
        token: options.gatewayToken(),
      })).pipe(
        Effect.flatMap(({ args, token }) =>
          fileSync.spawn(args, {
            env: { [MIRROR_GATEWAY_TOKEN_ENV]: token },
            stdin: Stream.fromQueue(input),
          }),
        ),
        Effect.tapError((error) =>
          FileSync.isFileSyncUnavailable(error)
            ? Effect.void
            : Effect.logWarning(
                `[mirror] daemon spawn failed: ${errorMessageOf(error)}`,
              ),
        ),
        Effect.option,
      );
      if (Option.isNone(spawned)) {
        yield* setStatus("unavailable");
        return;
      }
      const child = spawned.value;
      yield* Ref.set(stdin, Option.some(input));
      yield* setStatus("starting");
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim() !== ""),
        Stream.runForEach((line) =>
          Effect.logWarning(`[mirror] daemon: ${line.trim()}`),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(handleLine),
        Effect.ignore,
      );
      const code = yield* child.exitCode.pipe(
        Effect.map((exit): number | null => exit),
        Effect.orElseSucceed(() => null),
      );
      yield* Ref.set(stdin, Option.none());
      yield* Ref.set(sessions, []);
      yield* failAllPending("exited");
      yield* Effect.logWarning(
        `[mirror] daemon exited unexpectedly (code ${code}), restarting`,
      );
      yield* setStatus("starting");
      yield* changed;
    }).pipe(
      Effect.scoped,
      // Anything this run did not expect ends it like an exit, onto the
      // restart ladder, never the supervisor with it.
      Effect.catchCause((cause) =>
        Effect.logWarning("[mirror] daemon run failed, restarting", cause),
      ),
      Effect.timed,
      Effect.map(([duration]) => Duration.toMillis(duration)),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Ref.set(stdin, Option.none());
        yield* Ref.set(sessions, []);
        yield* failAllPending("stopped");
        yield* setStatus("stopped");
      }),
    );
    yield* runOnce.pipe(
      Effect.repeat(restartSchedule(RESTART_LADDER_MS)),
      Effect.forkScoped,
    );

    const request = (op: string, fields: Record<string, unknown>) =>
      Effect.gen(function* () {
        // Booked before the daemon is looked at, so an exit from here on
        // fails it with the rest.
        const id = String(nextRequestId++);
        const deferred = yield* Deferred.make<
          DaemonResponse,
          MirrorDaemonError
        >();
        pending.set(id, { op, response: deferred });
        const current = yield* Ref.get(status);
        const input = yield* Ref.get(stdin);
        if (Option.isNone(input) || current !== "running") {
          pending.delete(id);
          return yield* new MirrorDaemonError({
            op,
            reason: "not-running",
            detail: mirrorEngineBlocker(current),
          });
        }
        yield* Queue.offer(
          input.value,
          encoder.encode(JSON.stringify({ id, op, ...fields }) + "\n"),
        );
        const response = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: REQUEST_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(new MirrorDaemonError({ op, reason: "timed-out" })),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
        if (!response.ok) {
          return yield* new MirrorDaemonError({
            op,
            reason: "refused",
            detail: response.error,
          });
        }
        return response.session ?? "";
      });

    return MirrorDaemon.of({
      status: Ref.get(status),
      sessions: Ref.get(sessions),
      create: Effect.fn("MirrorDaemon.create")((input: MirrorCreateInput) =>
        request("create", { ...input }),
      ),
      terminate: Effect.fn("MirrorDaemon.terminate")((session: string) =>
        request("terminate", { session }),
      ),
      pause: Effect.fn("MirrorDaemon.pause")((session: string) =>
        request("pause", { session }),
      ),
      resume: Effect.fn("MirrorDaemon.resume")((session: string) =>
        request("resume", { session }),
      ),
    });
  });

export const layer = (options: Options) =>
  Layer.effect(MirrorDaemon, make(options));

// The Promise face, for the mirror bookkeeping in main/ipc/handlers.ts.
const {
  layer: adapterLayer,
  run,
  runSyncOr,
} = PromiseAdapter.make<MirrorDaemon>("The mirror daemon");
export const adapter = adapterLayer;

// The daemon's own effect, for a caller holding a runtime of its own
// (the proofs) or the adapter below.
export const onDaemon = <A, E>(
  f: (daemon: MirrorDaemon["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* MirrorDaemon);
  });

export const mirrorDaemon = {
  status: (): MirrorDaemonStatus =>
    runSyncOr(
      onDaemon((daemon) => daemon.status),
      () => "stopped",
    ),
  sessions: (): readonly MirrorSessionRaw[] =>
    runSyncOr(
      onDaemon((daemon) => daemon.sessions),
      () => [],
    ),
  create: (input: MirrorCreateInput) =>
    run(onDaemon((daemon) => daemon.create(input))),
  terminate: (session: string) =>
    run(onDaemon((daemon) => daemon.terminate(session))),
  pause: (session: string) => run(onDaemon((daemon) => daemon.pause(session))),
  resume: (session: string) =>
    run(onDaemon((daemon) => daemon.resume(session))),
};
