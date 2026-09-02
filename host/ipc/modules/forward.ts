// Host side of the port-forward wire (v2 step 8, slice A): a granted
// peer opens loopback TCP connections here and moves bytes through
// them as invoke/response calls (see the design note in
// shared/ipc/modules/forward.ts). The registry rides the shared idle
// registry (host/lib/idleRegistry.ts). Connections are ephemeral by
// design, nothing survives a restart and nothing is persisted.
import type { Socket } from "node:net";
import { errorMessageOf } from "@shared/errors";
import {
  FORWARD_CONN_CLOSED,
  FORWARD_CONNECT_FAILED,
  FORWARD_POLL_IN_FLIGHT,
  FORWARD_TOO_MANY_CONNS,
  FORWARD_UNKNOWN_CONN,
  forwardContract,
} from "@shared/ipc/modules/forward";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import { createIdleRegistry } from "@host/lib/idleRegistry";
import { dialLoopback, waitForDrainOrClose } from "@host/lib/net";

// How long a poll with nothing to report holds before answering empty.
// The wire has no per-call timeout, so the long-poll is what keeps a
// downlink invoke from hanging forever on a quiet socket: the client
// just re-polls on an empty answer.
const POLL_WAIT_MS = 10_000;
const CONN_IDLE_MS = 10 * 60_000;
// Grant-gated already (a trusted peer), so the cap is a sanity bound
// against a runaway client loop, not a quota. Sized for a real page
// load: a single browser tab opens ~6 keepalive sockets plus an HMR
// websocket, so the old cap of 8 saturated on one load and the next
// socket died silently. It must still sit well under
// MAX_IN_FLIGHT_PER_PEER = 64 (shared/ipc/socket/frames.ts, raised
// 32 -> 64 in the paired relay change): each conn parks a long-poll in
// one of the peer's shared in-flight slots, so a cap near that starves
// the peer's ordinary UI invokes.
const MAX_CONNS = 16;
// How long a dial may sit unanswered before the open refuses.
const DIAL_TIMEOUT_MS = 5_000;
// Inbound bytes buffered before the socket is paused. TCP flow control
// then pushes back on the loopback service until a poll drains us
// below the mark.
const BUFFER_HIGH_WATER = 4 * 1024 * 1024;

type Conn = {
  socket: Socket;
  // Inbound from the loopback service, waiting for a poll.
  chunks: Buffer[];
  buffered: number;
  // The stream is over (end, error or close). An error just ends the
  // stream, there is no separate error channel on the wire. eof is
  // reported only once the buffer is fully drained.
  remoteEnded: boolean;
  // The single pending poll's waker. Exactly one poll may wait per
  // conn. A second concurrent poll is a client bug and fails loudly.
  waker: (() => void) | null;
};

function wake(conn: Conn): void {
  conn.waker?.();
}

// The idle sweep is the entire lifecycle bookkeeping (see the
// idleRegistry header), same shape as the sync transfers: a client
// that vanished mid-stream leaks at most one loopback socket for
// CONN_IDLE_MS. Teardown is idempotent, and the drop callback marks
// the stream ended and wakes any pending poll BEFORE the registry
// check it re-runs (the delete already happened), so a poll parked on
// a dropped conn resolves eof instead of waiting out its timer.
const conns = createIdleRegistry<Conn>({
  idleMs: CONN_IDLE_MS,
  onDrop: (conn) => {
    conn.remoteEnded = true;
    conn.socket.destroy();
    wake(conn);
  },
});

// Parks the caller until data arrives, the stream ends, the conn is
// closed, or POLL_WAIT_MS passes. The waker slot doubles as the
// poll-in-flight latch: it is occupied for exactly the parked span.
function waitForActivity(conn: Conn): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.waker = null;
      resolve();
    }, POLL_WAIT_MS);
    timer.unref?.();
    conn.waker = () => {
      clearTimeout(timer);
      conn.waker = null;
      resolve();
    };
  });
}

// Splices up to `limit` raw bytes off the front of the inbound buffer.
function takeBuffered(conn: Conn, limit: number): Buffer {
  const taken: Buffer[] = [];
  let size = 0;
  while (conn.chunks.length > 0 && size < limit) {
    const head = conn.chunks[0] as Buffer;
    const room = limit - size;
    if (head.length <= room) {
      taken.push(head);
      size += head.length;
      conn.chunks.shift();
    } else {
      taken.push(head.subarray(0, room));
      conn.chunks[0] = head.subarray(room);
      size += room;
    }
  }
  conn.buffered -= size;
  return Buffer.concat(taken, size);
}

// Error messages below are stable markers, not prose (the FORWARD_*
// constants beside the contract): Electron IPC and the device wires
// both preserve only the message string, so the slice B client and the
// UI match these exact texts.

export const forwardHandlers: Handlers<typeof forwardContract, HandlerContext> =
  {
    open: async ({ port }) => {
      // The schema already pinned the range. Re-check so this handler
      // stays fail-closed even if it is ever reached off-contract.
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${FORWARD_CONNECT_FAILED}: port out of range`);
      }
      if (conns.size() >= MAX_CONNS) throw new Error(FORWARD_TOO_MANY_CONNS);
      // Loopback only, always: the feature is reaching the host's OWN
      // dev server, never using the host as a hop to its network. The
      // shared dial (host/lib/net.ts) tries 127.0.0.1 then ::1 and
      // carries its own deadline: this socket is not in the registry
      // yet so no sweep could reach a hung dial, and without one the
      // invoke would burn one of the peer's in-flight slots forever.
      let socket: Socket;
      try {
        socket = await dialLoopback(port, DIAL_TIMEOUT_MS);
      } catch (error) {
        throw new Error(`${FORWARD_CONNECT_FAILED}: ${errorMessageOf(error)}`, {
          cause: error,
        });
      }
      // Nagle batches small writes against the poll-based downlink's
      // round trips, so keystrokes and small frames must not wait on it.
      socket.setNoDelay(true);
      const conn: Conn = {
        socket,
        chunks: [],
        buffered: 0,
        remoteEnded: false,
        waker: null,
      };
      socket.on("data", (chunk: Buffer) => {
        conn.chunks.push(chunk);
        conn.buffered += chunk.length;
        if (conn.buffered > BUFFER_HIGH_WATER) socket.pause();
        wake(conn);
      });
      const ended = () => {
        conn.remoteEnded = true;
        wake(conn);
      };
      socket.on("end", ended);
      // 'close' always follows 'error', but the error listener must
      // exist or node treats the socket error as an uncaught throw.
      socket.on("error", ended);
      socket.on("close", ended);
      return { connId: conns.mint(conn) };
    },

    send: async ({ connId, dataB64 }) => {
      const conn = conns.get(connId);
      if (conn === undefined) throw new Error(FORWARD_UNKNOWN_CONN);
      conns.touch(connId);
      if (conn.remoteEnded) throw new Error(FORWARD_CONN_CLOSED);
      const data = Buffer.from(dataB64, "base64");
      if (!conn.socket.write(data)) {
        // Awaiting drain paces the sender to what the loopback service
        // actually consumes.
        await waitForDrainOrClose(conn.socket);
      }
      // A resolved send promises the bytes reached the local service. A
      // conn dropped or ended while the write was parked kept that
      // promise for none of them, so it must refuse, not resolve.
      if (conns.get(connId) !== conn || conn.remoteEnded) {
        throw new Error(FORWARD_CONN_CLOSED);
      }
    },

    poll: async ({ connId }) => {
      const conn = conns.get(connId);
      if (conn === undefined) throw new Error(FORWARD_UNKNOWN_CONN);
      conns.touch(connId);
      // The slice B client keeps exactly one poll in flight per conn.
      // A second is a bug, and serving it would race the two responses
      // over one byte stream.
      if (conn.waker !== null) throw new Error(FORWARD_POLL_IN_FLIGHT);
      if (conn.buffered === 0 && !conn.remoteEnded) {
        await waitForActivity(conn);
      }
      // Closed out from under the parked poll: the registry entry is
      // gone, so answer the teardown, not the buffer.
      if (conns.get(connId) !== conn) return { dataB64: "", eof: true };
      if (conn.buffered > 0) {
        const data = takeBuffered(conn, WIRE_CHUNK_BYTES);
        // eof only after the buffer is fully drained: bytes that raced
        // the stream's end still reach the client, on earlier polls.
        if (conn.buffered <= BUFFER_HIGH_WATER) conn.socket.resume();
        return { dataB64: data.toString("base64"), eof: false };
      }
      if (conn.remoteEnded) {
        await conns.drop(connId);
        return { dataB64: "", eof: true };
      }
      // Timed out empty. The client just re-polls.
      return { dataB64: "", eof: false };
    },

    close: async ({ connId }) => {
      await conns.drop(connId);
    },
  };
