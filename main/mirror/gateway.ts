// The loopback gateway this device's `file-sync daemon` reaches peers
// through (file-sync/engine.go, "Gateway protocol handler"). One listener for
// the app's life; every accepted socket is one mirror stream. The
// daemon writes a JSON preface line naming the peer device and the
// worktree there, the gateway opens the peer's `file-sync serve` on a
// byte channel of the direct session (forward:openMirror), answers
// "ok" (or "error <why>"), and from then on the socket is bridged onto
// that channel exactly like a port forward (main/portForward/
// bridge.ts). Nothing here knows Mutagen's protocol: the preface is
// the only line the gateway reads.
//
// Electron-free on purpose, like the port-forward engine: the mirror
// check drives this exact gateway over a real direct wire.
import { createServer, type Server, type Socket } from "node:net";
import { errorMessageOf } from "@shared/errors";
import type { forwardContract } from "@shared/ipc/modules/forward";
import type { Client } from "@shared/ipc/types";
import {
  type BridgedConn,
  bridgeSocket,
  type PeerChannels,
} from "../portForward/bridge";

export type MirrorPeerApi = Pick<Client<typeof forwardContract>, "openMirror">;

// The preface's shape (file-sync/engine.go mirrorPreface). Validated by hand
// rather than zod: this is a loopback line from our own child, and the
// only fields the gateway acts on are the three ids.
type Preface = {
  deviceId: string;
  projectId: string;
  worktreeId: string;
  session: string;
};

// A preface is a short JSON line; anything longer is not our daemon.
const PREFACE_LIMIT_BYTES = 8 * 1024;
// The daemon's own connect timeout is 30s (file-sync/engine.go), so a
// preface that has not arrived well before that is a dead dial.
const PREFACE_TIMEOUT_MS = 10_000;
// Sanity bound, not a quota: one stream per mirror session, and a
// runaway loop should not exhaust the peer's in-flight budget.
const MAX_STREAMS = 32;

function parsePreface(line: string): Preface {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("bad preface");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("bad preface");
  }
  const record = parsed as Record<string, unknown>;
  const field = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  const preface = {
    deviceId: field("deviceId"),
    projectId: field("projectId"),
    worktreeId: field("worktreeId"),
    session: field("session"),
  };
  if (
    preface.deviceId === "" ||
    preface.projectId === "" ||
    !/^[0-9a-f]{12}$/.test(preface.worktreeId)
  ) {
    throw new Error("bad preface");
  }
  return preface;
}

// Reads bytes until the first newline. Whatever follows it belongs to
// the stream and is handed back untouched.
function readPreface(
  socket: Socket,
): Promise<{ line: string; carried: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("preface timed out"));
    }, PREFACE_TIMEOUT_MS);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before the preface"));
    };
    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > PREFACE_LIMIT_BYTES) {
          cleanup();
          reject(new Error("preface too long"));
        }
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      cleanup();
      socket.pause();
      resolve({
        line: Buffer.concat(chunks).toString("utf8").trim(),
        carried: chunk.subarray(newline + 1),
      });
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

export type MirrorGateway = ReturnType<typeof createMirrorGateway>;

export function createMirrorGateway(deps: {
  peerApiFor: (deviceId: string) => MirrorPeerApi;
  peerChannelsFor: (deviceId: string) => PeerChannels;
  onChange?: () => void;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  let server: Server | null = null;
  let address: string | null = null;
  const streams = new Set<BridgedConn>();

  function handleConnection(socket: Socket): void {
    // 'close' always follows 'error'; the listener must exist or the
    // error is an uncaught throw.
    socket.on("error", () => {});
    if (streams.size >= MAX_STREAMS) {
      socket.end("error too many mirror streams\n");
      return;
    }
    readPreface(socket).then(
      ({ line, carried }) => {
        let preface: Preface;
        try {
          preface = parsePreface(line);
        } catch (error) {
          socket.end(`error ${errorMessageOf(error)}\n`);
          return;
        }
        const api = deps.peerApiFor(preface.deviceId);
        const conn = bridgeSocket(socket, {
          channels: deps.peerChannelsFor(preface.deviceId),
          open: (channelId) =>
            api.openMirror({
              projectId: preface.projectId,
              worktreeId: preface.worktreeId,
              channelId,
            }),
          carried,
          // The bridge resumes the socket itself once the far end is
          // open; the answer line goes out just before.
          onOpened: () => {
            socket.write("ok\n");
          },
          onOpenFailed: (error) => {
            log(
              `[mirror] gateway: opening ${preface.deviceId}/${preface.worktreeId} failed: ${errorMessageOf(error)}`,
            );
            socket.write(
              `error ${errorMessageOf(error).replace(/\n/g, " ")}\n`,
            );
          },
          onClosed: () => {
            streams.delete(conn);
            deps.onChange?.();
          },
        });
        streams.add(conn);
        deps.onChange?.();
      },
      (error: unknown) => {
        log(`[mirror] gateway: ${errorMessageOf(error)}`);
        socket.destroy();
      },
    );
  }

  // Binds the loopback listener on an ephemeral port and resolves its
  // host:port, the address the daemon is spawned with.
  async function start(): Promise<string> {
    if (address !== null) return address;
    const listener = createServer({ allowHalfOpen: true });
    listener.on("connection", handleConnection);
    listener.on("error", () => {});
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        listener.close();
        reject(error);
      };
      listener.once("error", onError);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", onError);
        const bound = listener.address();
        if (bound === null || typeof bound === "string") {
          listener.close();
          reject(new Error("gateway bound without a TCP address"));
          return;
        }
        resolve(bound.port);
      });
    });
    server = listener;
    address = `127.0.0.1:${port}`;
    return address;
  }

  function stop(): void {
    server?.close();
    server = null;
    address = null;
    for (const conn of streams) conn.destroy();
  }

  return {
    start,
    stop,
    address: () => address,
    streamCount: () => streams.size,
  };
}
