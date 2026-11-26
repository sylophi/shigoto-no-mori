// The link server (DeviceLink.ts) on loopback, for the processes on this
// machine: the terminal `sm` (packages/cli/src/Control.ts), the
// app's windows and its shell. It serves
// LoopbackGroup (@shigomori/contracts/link): every host call, its pushes
// and views, and the control contract's ops.
//
// Other accounts on this machine can reach loopback, so its hello
// carries a token minted as the host starts. The host publishes the
// port and the token in <dataDir>/loopback.json, owner-only, which is
// what names an app instance (flavor and dev profile) to the terminal,
// and hands them to whoever asks (address). A second token, handed to
// the shell alone over the port they share and written nowhere, opens
// the shell's session calls too (modules/session.ts).
//
// A token in the clear is enough here: loopback traffic never leaves the
// machine, so only this machine's own processes see it, and a dialer
// learns the port from the same owner-only file as the token, so nothing
// else can stand in for the listener it dials.
import type { IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  CLOSE_TRY_AGAIN,
  LoopbackFile,
  LoopbackGroup,
  loopbackPartialOf,
} from "@shigomori/contracts/link";
import { messageOf } from "@shigomori/engine/errorDocument";
import { mintHexId } from "@host/lib/hexId";
import { log } from "@shared/log";
import { MAX_MESSAGE_BYTES } from "./boundedMessages";
import { makeServer } from "./DeviceLink";

// Sockets the listener holds at once, a sanity bound against a runaway
// client.
const MAX_CONNECTIONS = 64;
// How long a socket asked to close has before it is cut.
const TERMINATE_GRACE_MS = 1_500;

// close() alone is advisory: ws keeps delivering frames for a while.
// The close frame, then a hard cut.
function closeThenTerminate(
  ws: WebSocket,
  code: number,
  reason: string,
  delayMs: number,
): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closing.
  }
  setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      // Already gone.
    }
  }, delayMs).unref();
}

class LoopbackBindError extends Schema.TaggedError<LoopbackBindError>()(
  "LoopbackBindError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The loopback listener could not start: ${this.reason}`;
  }
}

export class Loopback extends Context.Service<
  Loopback,
  {
    // Where the loopback listens, the token its handshake proves, and
    // the shell's.
    readonly address: Effect.Effect<{
      readonly port: number;
      readonly token: string;
      readonly shellToken: string;
    }>;
    // Takes loopback.json away, before the data-folder move carries the
    // data dir off: a terminal then reads the app as not running rather
    // than dialing one about to relaunch.
    readonly unpublish: Effect.Effect<void>;
  }
>()("sm/host/Loopback") {}

const make = (options: {
  readonly deviceId: string;
  readonly appVersion: string;
  // Where loopback.json goes: the data dir's, resolved late because the
  // data dir is a boot-time fact.
  readonly file: () => string;
  // The one page origin the listener admits beside an origin-less dial:
  // the desktop window's (its renderer scheme), which dials it too.
  readonly allowedOrigin?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const token = mintHexId();
    const shellToken = mintHexId();
    const server = yield* makeServer({
      group: LoopbackGroup,
      tokens: { token, shellToken },
      deviceId: options.deviceId,
      appVersion: options.appVersion,
      // Its callers command this machine as its owner.
      isCommandGranted: () => true,
    });
    const runFork = yield* FiberSet.makeRuntime<never>();
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      // An origin-less dial (the terminal's, the shell's) or the
      // window's own page.
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        req.headers.origin === undefined ||
        req.headers.origin === options.allowedOrigin,
    });
    wss.on("connection", (ws) => {
      if (wss.clients.size > MAX_CONNECTIONS) {
        closeThenTerminate(ws, CLOSE_TRY_AGAIN, "over capacity", 50);
        return;
      }
      ws.on("error", (error) => {
        log.warn(`[link] connection error: ${messageOf(error)}`);
      });
      runFork(
        server.accept(ws, {
          from: "loopback",
          cut: (code, reason) => closeThenTerminate(ws, code, reason, 250),
        }),
      );
    });
    yield* Effect.callback<void, LoopbackBindError>((resume) => {
      wss.once("error", (error) =>
        resume(
          Effect.fail(new LoopbackBindError({ reason: messageOf(error) })),
        ),
      );
      wss.once("listening", () => resume(Effect.void));
    });
    wss.on("error", (error) => {
      log.warn(`[link] loopback listener error: ${messageOf(error)}`);
    });
    yield* Effect.addFinalizer(() =>
      Effect.callback<void>((resume) => {
        const grace = setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
        }, TERMINATE_GRACE_MS);
        wss.close(() => {
          clearTimeout(grace);
          resume(Effect.void);
        });
      }),
    );
    const address = wss.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    const content = Schema.encodeSync(LoopbackFile)({
      pid: process.pid,
      port,
      token,
      appVersion: options.appVersion,
    });
    // Written aside and renamed in, so a terminal never reads half of it.
    const publish = Effect.gen(function* () {
      const file = options.file();
      const partial = loopbackPartialOf(file, process.pid);
      yield* fs.writeFileString(partial, content, { mode: 0o600 });
      yield* fs.rename(partial, file);
    }).pipe(Effect.ignore, Effect.withSpan("Loopback.publish"));
    // Only the file this listener wrote: another instance may have
    // published its own since.
    const unpublish = Effect.gen(function* () {
      const file = options.file();
      const held = yield* fs.readFileString(file);
      if (held === content) yield* fs.remove(file);
    }).pipe(Effect.ignore, Effect.withSpan("Loopback.unpublish"));
    yield* publish;
    yield* Effect.addFinalizer(() => unpublish);
    return Loopback.of({
      address: Effect.succeed({ port, token, shellToken }),
      unpublish,
    });
  });

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(Loopback, make(options));
