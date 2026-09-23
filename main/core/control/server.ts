// The control wire: the loopback listener the CLI reaches the running
// app through (`sm worktrees send|bring|mirror`, cli/control.go). A
// ServerTransport like the other wires, so the control contract
// registers on it through the shared registrar.
//
// Newline-delimited JSON: the client says hello with the token, then
// each line is one `req`, answered by one `res`, with `push` lines in
// between for the broadcasts a handler streams to its caller
// (sync:pullProgress). A closed socket aborts the context's signal, but
// the transfer orchestrators do not read it, so a transfer that started
// runs to its end like one whose dialog was closed.
//
// The CLI finds the listener through control.json in the data dir,
// which is what names an app instance (flavor and dev profile). Other
// accounts on this machine can reach loopback, so the file carries a
// token minted at bind and is written owner-only.
//
// One bind is one run: an Effect scope holding the listener, the
// published file and every connection, each connection in a child
// scope of its own whose close aborts the context's signal and
// destroys the socket. stop() unpublishes and closes the run's scope,
// which tears the rest down in reverse order, in the same call on the
// default runtime. The hello deadline is a timeout on the connection's
// fiber, and a connection's calls are fibers of its scope, so neither
// a timer nor a socket set nor an in-flight counter is kept by hand.
//
// Electron-free on purpose: test/control.mjs drives this exact server.
import { createServer, type Socket } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Iterable,
  Option,
  Schema,
  Scope,
} from "effect";
import { errorCodeOf, errorMessageOf } from "@shared/errors";
import { noHandlerMessage } from "@shared/hub/link";
import { isControlErrorCode } from "@shared/ipc/modules/control";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import {
  decodeFrame,
  HELLO_TIMEOUT_MS,
  MAX_IN_FLIGHT_PER_PEER,
  MAX_INBOUND_FRAME_BYTES,
  PUSH_BUFFER_LIMIT_BYTES,
  ReqFrameSchema,
} from "@shared/ipc/socket/frames";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import {
  defaultSupervisorRuntime,
  type RuntimeOf,
} from "@shared/remote/supervisor";
import { mintHexId } from "@host/lib/idleRegistry";
import { atomicWriteJsonSync } from "@host/lib/util/jsonFile";
import { lineSplitter } from "@host/lib/util/ndjson";
import { secretsMatch } from "@host/lib/util/secretCompare";
import { listenLoopback } from "../portForward/bridge";
import { wireFailure } from "@shared/ipc/wireError";
import { answerCall, containedSync } from "@shared/util/contained";

// cli/control.go reads this exact name and shape.
export const CONTROL_FILE_NAME = "control.json";

export type ControlFile = {
  pid: number;
  port: number;
  token: string;
  appVersion: string;
};

// A terminal or an agent runs a handful of commands at once, never
// dozens.
export const MAX_CONNECTIONS = 16;

const HelloSchema = Schema.Struct({
  t: Schema.Literal("hello"),
  token: Schema.String,
});

type Handler = (ctx: HandlerContext, raw: unknown) => Promise<unknown>;

function send(socket: Socket, frame: Record<string, unknown>): void {
  if (socket.destroyed || !socket.writable) return;
  // Progress is droppable presence (sync:pullProgress), and a terminal
  // that stopped reading must not grow a queue in the app for as long
  // as its transfer runs. An answer always goes.
  if (frame.t === "push" && socket.writableLength > PUSH_BUFFER_LIMIT_BYTES) {
    return;
  }
  socket.write(`${JSON.stringify(frame)}\n`);
}

// Why a connection was turned away, for the CLI to key on: "busy" is
// worth a retry, "bad-token" is a control.json this listener did not
// write.
function refuse(socket: Socket, code: string, message: string): void {
  socket.end(`${JSON.stringify({ t: "refused", code, message })}\n`);
}

// The answer to a call that threw. Only the codes this wire owns: a
// Node errno riding an error would otherwise become a CLI error kind.
function failedRes(id: unknown, error: unknown): Record<string, unknown> {
  const code = errorCodeOf(error);
  return {
    t: "res",
    id,
    ok: false,
    ...wireFailure(error),
    ...(isControlErrorCode(code) ? { code } : {}),
  };
}

export function createControlServer(deps: {
  appVersion: () => string;
  // Where control.json goes: the data dir's, resolved late because the
  // data dir is a boot-time fact.
  filePath: () => string;
  log?: (message: string) => void;
  // Where the run's fibers live. Real callers take Effect's default
  // services. A test passes a ManagedRuntime built on TestClock.layer()
  // and moves the hello deadline with TestClock.adjust.
  runtime?: RuntimeOf<never>;
}) {
  const runtime = deps.runtime ?? defaultSupervisorRuntime;
  const handlers = new Map<string, Handler>();
  // The current bind: the scope stop() closes, and the start() every
  // caller until then shares.
  let run: { scope: Scope.Closeable; started: Promise<void> } | null = null;
  // What is on disk for the current bind, for republish().
  let file: ControlFile | null = null;
  let published: string | null = null;

  // The owner's logger runs from socket callbacks and fibers alike, so
  // a throw from it is contained here rather than crashing a callback
  // or ending a fiber with a defect nothing reports.
  function log(message: string): void {
    containedSync("[control] log threw", () =>
      (deps.log ?? console.warn)(message),
    );
  }

  // One call, as a fiber of its connection's scope: the Promise handler
  // runs to its answer unless the connection closes first, in which
  // case there is no one to answer.
  const answer = (
    socket: Socket,
    ctx: HandlerContext,
    id: unknown,
    fn: Handler,
    input: unknown,
  ): Effect.Effect<void> =>
    answerCall({
      run: () => fn(ctx, input),
      ok: (result) => send(socket, { t: "res", id, ok: true, result }),
      failed: (error) => send(socket, failedRes(id, error)),
      label: "[control] a call failed",
      log,
    });

  // One connection, from accept to close, inside its own scope. The
  // scope closes when the socket does, when the hello deadline passes
  // without a hello, or when stop() closes the run. Closing it
  // interrupts the calls still running, aborts the context's signal
  // and destroys the socket.
  const serveConnection = (
    socket: Socket,
    token: string,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          controller.abort();
          socket.destroy();
        }),
      );
      const closed = Deferred.makeUnsafe<void>();
      socket.on("close", () => {
        Deferred.doneUnsafe(closed, Effect.void);
      });
      // The connection's running calls, capped like a peer's.
      const calls = yield* FiberSet.make<void>();
      const runCall = yield* FiberSet.runtime(calls)();
      const ctx: HandlerContext = {
        signal: controller.signal,
        // A local process of this user commands its own machine, like a
        // local window.
        isCallerCommandGranted: () => true,
        notifier: (module, key) => (payload) => {
          const { channel, parsed } = resolveBroadcast(module, key, payload);
          send(socket, { t: "push", channel, payload: parsed });
        },
      };

      const dispatch = (line: string): void => {
        const parsed = decodeFrame(line, ReqFrameSchema);
        if (parsed === null) {
          // One malformed line must not kill a connection carrying
          // another call, and with no id there is nothing to answer.
          log("[control] dropping an unparseable line");
          return;
        }
        const fn = handlers.get(parsed.channel);
        if (fn === undefined) {
          send(socket, {
            t: "res",
            id: parsed.id,
            ok: false,
            message: noHandlerMessage(parsed.channel),
          });
          return;
        }
        if (Iterable.size(calls) >= MAX_IN_FLIGHT_PER_PEER) {
          send(socket, {
            t: "res",
            id: parsed.id,
            ok: false,
            message: "too many in-flight requests",
          });
          return;
        }
        runCall(answer(socket, ctx, parsed.id, fn, parsed.input));
      };

      // Completed by a good hello, which lifts the deadline.
      const hello = Deferred.makeUnsafe<void>();
      // The first line is the hello. What the later ones mean depends
      // on how it went.
      let onLine = (line: string): void => {
        const frame = decodeFrame(line, HelloSchema);
        if (frame === null || !secretsMatch(frame.token, token)) {
          // Nothing legitimate reaches here, so log it. The refusal is
          // the last word: later lines are not read, and the socket
          // goes when the client hangs up or at the deadline.
          log("[control] refused a connection with a bad hello");
          refuse(socket, "bad-token", "bad token");
          onLine = () => {};
          return;
        }
        onLine = dispatch;
        send(socket, { t: "welcome", appVersion: deps.appVersion() });
        Deferred.doneUnsafe(hello, Effect.void);
      };

      // A request names a channel and carries a small payload. A line
      // that outgrows a frame is not our CLI.
      let unbroken = 0;
      const split = lineSplitter((line) => onLine(line));
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        const lastNewline = chunk.lastIndexOf("\n");
        unbroken =
          lastNewline < 0
            ? unbroken + chunk.length
            : chunk.length - lastNewline - 1;
        if (unbroken > MAX_INBOUND_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        split(chunk);
      });

      // Held until the socket closes, or until the deadline passes with
      // no hello, which ends the scope and so destroys the socket.
      yield* Effect.raceFirst(
        Deferred.await(closed),
        Deferred.await(hello).pipe(
          Effect.timeoutOption(HELLO_TIMEOUT_MS),
          Effect.flatMap((welcomed) =>
            Option.isSome(welcomed) ? Effect.never : Effect.void,
          ),
        ),
      );
    });

  function publish(next: ControlFile): void {
    const path = deps.filePath();
    // selfWrite: false because this is control-plane plumbing the
    // state watcher ignores, not user state.
    atomicWriteJsonSync(path, next, { selfWrite: false, mode: 0o600 });
    file = next;
    published = path;
  }

  function unpublish(): void {
    file = null;
    if (published === null) return;
    try {
      rmSync(published, { force: true });
    } catch {
      // A leftover file names a dead port, which the CLI reads as "not
      // running" once its pid check or its dial fails.
    }
    published = null;
  }

  // One bind, its resources acquired into the run's scope: the
  // connections' set, the listener, then the file, released in the
  // reverse order.
  const serve: Effect.Effect<void, unknown, Scope.Scope> = Effect.gen(
    function* () {
      // Minted per bind, so a token cannot outlive the listener it
      // opened.
      const token = mintHexId();
      const connections = yield* FiberSet.make<void>();
      const runConnection = yield* FiberSet.runtime(connections)();
      const port = yield* Effect.acquireRelease(
        Effect.suspend(() => {
          const listener = createServer((socket) => {
            // 'close' always follows 'error'. The listener must exist
            // or the error is an uncaught throw.
            socket.on("error", () => {});
            if (Iterable.size(connections) >= MAX_CONNECTIONS) {
              refuse(socket, "busy", "too many control connections");
              return;
            }
            runConnection(Effect.scoped(serveConnection(socket, token)));
          });
          listener.on("error", () => {});
          return Effect.tryPromise({
            try: () =>
              listenLoopback(listener, 0).then((bound) => ({
                listener,
                port: bound,
              })),
            catch: (error) => error,
          });
        }),
        ({ listener }) => Effect.sync(() => listener.close()),
      ).pipe(Effect.map(({ port: bound }) => bound));
      yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            publish({
              pid: process.pid,
              port,
              token,
              appVersion: deps.appVersion(),
            }),
          catch: (error) => error,
        }),
        () => Effect.sync(unpublish),
      );
    },
  );

  // Binds the loopback listener on an ephemeral port and publishes it.
  // A stop() while the bind is in flight wins: the listener is closed
  // as soon as it is bound, nothing is published, and this resolves.
  function start(): Promise<void> {
    if (run !== null) return run.started;
    const scope = Scope.makeUnsafe();
    const current = {
      scope,
      started: runtime
        .runPromise(
          Effect.forkIn(Scope.provide(serve, scope), scope).pipe(
            Effect.flatMap(Fiber.join),
            Effect.onError(() => Scope.close(scope, Exit.void)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.failCause(cause),
            ),
          ),
        )
        .catch((error: unknown) => {
          // A failed bind leaves nothing behind, so a later start()
          // tries again.
          if (run === current) run = null;
          throw error;
        }),
    };
    run = current;
    return current.started;
  }

  // Puts the file back after a data wipe (host/lib/nuke.ts) removed the
  // data dir under the running app and reseeded it: without the file
  // the CLI would call a live app "not running" until its next launch.
  // Only into a data dir that is there, since the write would otherwise
  // bring back one the wipe retired on purpose (the pre-2.0 name).
  function republish(): void {
    try {
      if (file !== null && existsSync(dirname(deps.filePath()))) {
        publish(file);
      }
    } catch (error) {
      log(`[control] could not republish: ${errorMessageOf(error)}`);
    }
  }

  // Synchronous so every quit path can call it on its way out. The file
  // goes first, so a CLI run that starts now reads "not running". Then
  // the run's scope closes, which on the default runtime closes the
  // listener and every connection before this returns.
  function stop(): void {
    unpublish();
    const ending = run;
    run = null;
    if (ending !== null) runtime.runFork(Scope.close(ending.scope, Exit.void));
  }

  const transport: ServerTransport = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    // Nothing fans out here: a control connection hears only what its
    // own call streams through the context's notifier.
    broadcastAll() {},
  };

  return { transport, start, stop, republish };
}
