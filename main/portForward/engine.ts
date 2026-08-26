// The client half of the port-forward wire (v2 step 8, slice B): binds
// loopback listeners on this machine and shuttles each accepted
// socket's bytes through a peer's forward verbs (the host side in
// host/ipc/modules/forward.ts, the wire rules in
// shared/ipc/modules/forward.ts). Electron-free on purpose, node:net
// plus injected dependencies, so the e2e check drives the real engine
// over the stub relay (scripts/check-port-forward.mjs) while main/ipc
// wires forwardApiFor over the relay bridge's shared peer sessions.
//
// The wire allows no retries: poll is a destructive read and send is
// not idempotent, so ANY rejection from either call (relay flap, peer
// offline, unknown-conn) tears the conn down and destroys the local
// socket, never re-issuing the failed call. Teardown sends
// forward:close best-effort, and only while the conn might still exist
// host-side: after eof or an "unknown-conn" refusal the host has
// already dropped it (that message is one of the stable markers the
// host side promises to keep, see the note above its handlers).
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { errorMessageOf } from "@shared/errors";
import type { forwardContract } from "@shared/ipc/modules/forward";
import type { Client } from "@shared/ipc/types";
import { RELAY_CHUNK_BYTES } from "@shared/relay/protocol";

export type ForwardApi = Client<typeof forwardContract>;

// Client-side mirror of the host's MAX_CONNS (host/ipc/modules/
// forward.ts). That ceiling is per host process, so this count spans
// ALL forwards to one device, not each forward alone. The 9th conn
// would be refused there anyway, but only after a full open round trip
// that burns one of the peer's shared relay in-flight slots, so an
// accepted socket over the cap is destroyed immediately instead.
const MAX_CONNS_PER_DEVICE = 8;

// Uplink backlog bound: bytes read off the local socket, queued and
// not yet handed to a send. Over it the local socket pauses, and TCP flow
// control pushes back on the local client until the send pump drains
// the queue empty again.
const UPLINK_HIGH_WATER = 4 * 1024 * 1024;

const isUnknownConn = (error: unknown) =>
  errorMessageOf(error).includes("unknown-conn");

export type PortForwardSummary = {
  forwardId: string;
  deviceId: string;
  remotePort: number;
  localPort: number;
  connCount: number;
};

type Conn = {
  // Minted by the host's open. Null while the dial is in flight, and
  // the uplink pump waits on it.
  connId: string | null;
  // Teardown ran. Every in-flight promise resolution checks this
  // before touching the socket or issuing another call, so a late
  // send/poll settlement cannot write to a dead socket or re-poll (the
  // pump-zombie guard).
  dead: boolean;
  // The host already dropped the conn (eof answered, or a call refused
  // with "unknown-conn"), so teardown must not send a close for it.
  remoteGone: boolean;
  // Uplink backlog, pre-sliced so every entry is one wire chunk.
  queue: Buffer[];
  queuedBytes: number;
  sendInFlight: boolean;
  paused: boolean;
  destroy: (opts: { closeRemote: boolean }) => void;
};

type Forward = {
  forwardId: string;
  deviceId: string;
  remotePort: number;
  localPort: number;
  server: Server;
  conns: Set<Conn>;
  api: ForwardApi;
};

export type PortForwardEngine = ReturnType<typeof createPortForwardEngine>;

export function createPortForwardEngine(deps: {
  forwardApiFor: (deviceId: string) => ForwardApi;
  onChange?: () => void;
}) {
  const forwards = new Map<string, Forward>();
  const changed = () => deps.onChange?.();

  function liveConnsTo(deviceId: string): number {
    let count = 0;
    for (const forward of forwards.values()) {
      if (forward.deviceId === deviceId) count += forward.conns.size;
    }
    return count;
  }

  function handleConnection(forward: Forward, socket: Socket): void {
    if (liveConnsTo(forward.deviceId) >= MAX_CONNS_PER_DEVICE) {
      socket.destroy();
      return;
    }
    const conn: Conn = {
      connId: null,
      dead: false,
      remoteGone: false,
      queue: [],
      queuedBytes: 0,
      sendInFlight: false,
      paused: false,
      destroy: (opts) => fail(opts),
    };
    forward.conns.add(conn);
    changed();
    // Nagle would batch small local writes against the wire's round
    // trips, mirroring the host side's reasoning.
    socket.setNoDelay(true);

    function fail({ closeRemote }: { closeRemote: boolean }): void {
      if (conn.dead) return;
      conn.dead = true;
      forward.conns.delete(conn);
      socket.destroy();
      if (closeRemote && conn.connId !== null && !conn.remoteGone) {
        void forward.api.close({ connId: conn.connId }).catch(() => {});
      }
      changed();
    }

    // Exactly one send in flight, the rest queued: send resolutions
    // promise delivery order, and a second concurrent send would race
    // two chunks over one byte stream.
    function pumpUplink(): void {
      if (conn.dead || conn.sendInFlight || conn.connId === null) return;
      const chunk = conn.queue.shift();
      if (chunk === undefined) return;
      conn.queuedBytes -= chunk.length;
      if (conn.paused && conn.queuedBytes === 0) {
        conn.paused = false;
        socket.resume();
      }
      conn.sendInFlight = true;
      forward.api
        .send({ connId: conn.connId, dataB64: chunk.toString("base64") })
        .then(
          () => {
            conn.sendInFlight = false;
            if (!conn.dead) pumpUplink();
          },
          (error: unknown) => {
            conn.sendInFlight = false;
            fail({ closeRemote: !isUnknownConn(error) });
          },
        );
    }

    // One poll loop per conn, exactly one poll in flight (the host
    // refuses a second). An empty non-eof answer is the long-poll
    // timing out on a quiet socket: re-poll immediately. The poll
    // cadence doubles as the downlink flow control, so a local write
    // that overruns the socket buffer parks the loop on drain before
    // asking the host for more.
    async function pumpDownlink(connId: string): Promise<void> {
      while (!conn.dead) {
        let result;
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential by design
          result = await forward.api.poll({ connId });
        } catch (error) {
          fail({ closeRemote: !isUnknownConn(error) });
          return;
        }
        if (conn.dead) return;
        if (result.dataB64 !== "") {
          const data = Buffer.from(result.dataB64, "base64");
          if (!socket.write(data)) {
            // 'close' releases a wait the socket died under, exactly
            // like the host's send-side drain wait.
            // oxlint-disable-next-line no-await-in-loop -- sequential by design
            await new Promise<void>((resolve) => {
              const done = () => {
                socket.off("drain", done);
                socket.off("close", done);
                resolve();
              };
              socket.once("drain", done);
              socket.once("close", done);
            });
            if (conn.dead) return;
          }
        }
        if (result.eof) {
          // eof already dropped the conn host-side, so no close, just
          // pass the FIN on. The local close that follows finishes the
          // teardown through the socket's close handler.
          conn.remoteGone = true;
          socket.end();
          return;
        }
      }
    }

    socket.on("data", (data: Buffer) => {
      if (conn.dead) return;
      // Slice at enqueue time so every queued entry already fits one
      // send frame under the relay cap.
      for (let offset = 0; offset < data.length; offset += RELAY_CHUNK_BYTES) {
        conn.queue.push(data.subarray(offset, offset + RELAY_CHUNK_BYTES));
      }
      conn.queuedBytes += data.length;
      if (!conn.paused && conn.queuedBytes > UPLINK_HIGH_WATER) {
        conn.paused = true;
        socket.pause();
      }
      pumpUplink();
    });
    // A local FIN has no wire form (the protocol has no half-close), so
    // there is nothing to signal on 'end': data just stops arriving and
    // the downlink keeps flowing until the remote side ends or the
    // socket fully closes (the listener's allowHalfOpen keeps node from
    // auto-ending the writable side here). The accepted tradeoff: a
    // half-closing client whose remote never ends holds the conn until
    // the forward stops.
    // 'close' always follows 'error', but the error listener must exist
    // or node treats the socket error as an uncaught throw.
    socket.on("error", () => {});
    socket.on("close", () => fail({ closeRemote: true }));

    forward.api.open({ port: forward.remotePort }).then(
      ({ connId }) => {
        if (conn.dead) {
          // The local socket died while the dial was in flight, so the
          // fresh conn is orphaned: close it now rather than leak it
          // until the host's idle sweep.
          void forward.api.close({ connId }).catch(() => {});
          return;
        }
        conn.connId = connId;
        pumpUplink();
        void pumpDownlink(connId);
      },
      () => fail({ closeRemote: false }),
    );
  }

  async function startForward(input: {
    deviceId: string;
    remotePort: number;
    localPort?: number;
  }): Promise<{ forwardId: string; localPort: number }> {
    // One forward per (deviceId, remotePort): starting an existing pair
    // returns it unchanged. Idempotent by choice, the simpler contract
    // for a UI whose start doubles as "make sure this is forwarded".
    for (const existing of forwards.values()) {
      if (
        existing.deviceId === input.deviceId &&
        existing.remotePort === input.remotePort
      ) {
        return { forwardId: existing.forwardId, localPort: existing.localPort };
      }
    }
    const api = deps.forwardApiFor(input.deviceId);
    // Probe the remote service before binding anything: one open and
    // best-effort close, so a dead port, a revoked grant or an offline
    // peer rejects the start with its coded error instead of minting a
    // listener whose conns die on arrival.
    const probe = await api.open({ port: input.remotePort });
    // Awaited (rejection still ignored) so a relay flap between open
    // and close cannot leak the probe's host conn slot for the idle
    // sweep to reap ten minutes later.
    await api.close({ connId: probe.connId }).catch(() => {});
    // allowHalfOpen: a client FIN must not tear the conn down (see the
    // 'end' note in handleConnection), but node's default would
    // auto-end the writable side and drop the remote's response.
    const server = createServer({ allowHalfOpen: true });
    // Loopback only, matching the host side: the forward is for THIS
    // machine's processes, never a listener other hosts can reach.
    const localPort = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        // e.g. EADDRINUSE on an explicit localPort: release the handle
        // rather than leak an unbound server.
        server.close();
        reject(error);
      };
      server.once("error", onError);
      server.listen(input.localPort ?? 0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("listener bound without a TCP address"));
          return;
        }
        resolve(address.port);
      });
    });
    // The dedupe scan above ran before two awaits, so a concurrent
    // start for the same pair may have bound in the meantime: yield to
    // the twin and release the just-bound listener.
    for (const existing of forwards.values()) {
      if (
        existing.deviceId === input.deviceId &&
        existing.remotePort === input.remotePort
      ) {
        server.close();
        return { forwardId: existing.forwardId, localPort: existing.localPort };
      }
    }
    const forward: Forward = {
      forwardId: randomBytes(16).toString("hex"),
      deviceId: input.deviceId,
      remotePort: input.remotePort,
      localPort,
      server,
      conns: new Set(),
      api,
    };
    server.on("connection", (socket) => handleConnection(forward, socket));
    // A bound listener errors only in exotic cases, but an unlistened
    // 'error' would take the whole process down.
    server.on("error", () => {});
    forwards.set(forward.forwardId, forward);
    changed();
    return { forwardId: forward.forwardId, localPort };
  }

  // Idempotent: stopping an unknown or already-stopped forward is a
  // no-op. Live conns are torn down with a best-effort close each.
  function stopForward(forwardId: string): void {
    const forward = forwards.get(forwardId);
    if (forward === undefined) return;
    forwards.delete(forwardId);
    forward.server.close();
    // destroy deletes only the conn being visited, which Set iteration
    // tolerates.
    for (const conn of forward.conns) {
      conn.destroy({ closeRemote: true });
    }
    changed();
  }

  function listForwards(): PortForwardSummary[] {
    return [...forwards.values()].map((forward) => ({
      forwardId: forward.forwardId,
      deviceId: forward.deviceId,
      remotePort: forward.remotePort,
      localPort: forward.localPort,
      connCount: forward.conns.size,
    }));
  }

  // Shutdown teardown. Synchronous on the local side (listeners and
  // sockets die now), best-effort on the wire.
  function stopAll(): void {
    for (const forwardId of forwards.keys()) stopForward(forwardId);
  }

  return { startForward, stopForward, listForwards, stopAll };
}
