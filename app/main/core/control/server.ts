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
// Electron-free on purpose: test/control.mjs drives this exact server.
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { errorCodeOf, errorMessageOf } from "@shared/errors";
import { isControlErrorCode } from "@shared/ipc/modules/control";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import {
  decodeFrame,
  HELLO_TIMEOUT_MS,
  MAX_IN_FLIGHT_PER_PEER,
  MAX_INBOUND_FRAME_BYTES,
  noHandlerMessage,
  PUSH_BUFFER_LIMIT_BYTES,
  ReqFrameSchema,
  resError,
} from "@shared/ipc/socket/frames";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import { mintHexId } from "@host/lib/hexId";
import { atomicWriteJsonSync } from "@host/lib/util/jsonFile";
import { lineSplitter } from "@host/lib/util/ndjson";
import { secretsMatch } from "@host/lib/util/secretCompare";
import { listenLoopback } from "../portForward/bridge";

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
const MAX_CONNECTIONS = 16;

const HelloSchema = z.object({ t: z.literal("hello"), token: z.string() });

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

export function createControlServer(deps: {
  appVersion: () => string;
  // Where control.json goes: the data dir's, resolved late because the
  // data dir is a boot-time fact.
  filePath: () => string;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const handlers = new Map<string, Handler>();
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let token: string | null = null;
  let file: ControlFile | null = null;
  let published: string | null = null;

  async function dispatch(
    socket: Socket,
    ctx: HandlerContext,
    // The connection's running calls, capped like a peer's.
    inFlight: { count: number },
    line: string,
  ): Promise<void> {
    const parsed = decodeFrame(line, ReqFrameSchema);
    if (parsed === null) {
      // One malformed line must not kill a connection carrying another
      // call, and with no id there is nothing to answer.
      log("[control] dropping an unparseable line");
      return;
    }
    const fn = handlers.get(parsed.channel);
    if (fn === undefined) {
      send(socket, resError(parsed.id, noHandlerMessage(parsed.channel)));
      return;
    }
    if (inFlight.count >= MAX_IN_FLIGHT_PER_PEER) {
      send(socket, resError(parsed.id, "too many in-flight requests"));
      return;
    }
    inFlight.count += 1;
    try {
      const result = await fn(ctx, parsed.input);
      send(socket, { t: "res", id: parsed.id, ok: true, result });
    } catch (error) {
      // Only the codes this wire owns: a Node errno riding an error
      // would otherwise become a CLI error kind.
      const code = errorCodeOf(error);
      send(
        socket,
        resError(
          parsed.id,
          errorMessageOf(error),
          isControlErrorCode(code) ? code : undefined,
        ),
      );
    } finally {
      inFlight.count -= 1;
    }
  }

  function handleConnection(socket: Socket): void {
    // 'close' always follows 'error'. The listener must exist or the
    // error is an uncaught throw.
    socket.on("error", () => {});
    if (sockets.size >= MAX_CONNECTIONS) {
      refuse(socket, "busy", "too many control connections");
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    const notifier: HandlerContext["notifier"] = (module, key) => (payload) => {
      const { channel, parsed } = resolveBroadcast(module, key, payload);
      send(socket, { t: "push", channel, payload: parsed });
    };
    const ctx: HandlerContext = {
      signal: controller.signal,
      notifier,
    };
    const inFlight = { count: 0 };
    let authed = false;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    const onLine = (line: string) => {
      if (authed) {
        void dispatch(socket, ctx, inFlight, line);
        return;
      }
      const hello = decodeFrame(line, HelloSchema);
      if (hello === null || !secretsMatch(hello.token, token ?? "")) {
        // Nothing legitimate reaches here, so log it.
        log("[control] refused a connection with a bad hello");
        refuse(socket, "bad-token", "bad token");
        return;
      }
      authed = true;
      clearTimeout(helloTimer);
      send(socket, { t: "welcome", appVersion: deps.appVersion() });
    };

    // A request names a channel and carries a small payload. A line
    // that outgrows a frame is not our CLI.
    let unbroken = 0;
    const split = lineSplitter(onLine);
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
    socket.on("close", () => {
      clearTimeout(helloTimer);
      sockets.delete(socket);
      controller.abort();
    });
  }

  function unpublish(): void {
    if (published === null) return;
    try {
      rmSync(published, { force: true });
    } catch {
      // A leftover file names a dead port, which the CLI reads as "not
      // running" once its pid check or its dial fails.
    }
    published = null;
  }

  // Binds the loopback listener on an ephemeral port and publishes it.
  async function start(): Promise<void> {
    if (server !== null) return;
    const listener = createServer();
    listener.on("connection", handleConnection);
    listener.on("error", () => {});
    const port = await listenLoopback(listener, 0);
    server = listener;
    // Minted per bind, so a token cannot outlive the listener it opened.
    token = mintHexId();
    file = { pid: process.pid, port, token, appVersion: deps.appVersion() };
    publish();
  }

  function publish(): void {
    if (file === null) return;
    const path = deps.filePath();
    // selfWrite: false because this is control-plane plumbing the
    // state watcher ignores, not user state.
    atomicWriteJsonSync(path, file, { selfWrite: false, mode: 0o600 });
    published = path;
  }

  // Puts the file back after a data wipe (host/lib/nuke.ts) removed the
  // data dir under the running app and reseeded it: without the file
  // the CLI would call a live app "not running" until its next launch.
  // Only into a data dir that is there, since the write would otherwise
  // bring back one the wipe retired on purpose (the pre-2.0 name).
  function republish(): void {
    try {
      if (existsSync(dirname(deps.filePath()))) publish();
    } catch (error) {
      log(`[control] could not republish: ${errorMessageOf(error)}`);
    }
  }

  // Synchronous so every quit path can call it on its way out.
  function stop(): void {
    unpublish();
    file = null;
    server?.close();
    server = null;
    token = null;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
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
