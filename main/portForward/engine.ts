// The client half of port forwarding (v2 step 8, slice B, reworked
// onto byte channels): binds loopback listeners on this machine and
// bridges each accepted socket onto a channel of the peer's direct
// session, opened with forward:open (the host side in
// host/ipc/modules/forward.ts, the wire rules in
// shared/ipc/modules/forward.ts). Electron-free on purpose, node:net
// plus injected dependencies, so the e2e check drives the real engine
// over a real device wire (scripts/check-port-forward.mjs) while
// main/ipc wires the peer reach over the bridge's shared direct
// sessions.
//
// The per-socket bridging (attach, open, the adapter's backpressure and
// teardown) lives in bridge.ts, shared with the mirror gateway; this
// file owns the listeners, the per-device conn cap and the forward
// registry.
import { createServer, type Server, type Socket } from "node:net";
import type { forwardContract } from "@shared/ipc/modules/forward";
import type { Client } from "@shared/ipc/types";
import { mintHexId } from "@host/lib/idleRegistry";
import { type BridgedConn, bridgeSocket, type PeerChannels } from "./bridge";

export type ForwardApi = Client<typeof forwardContract>;

// Client-side cap on live conns per device, under the host's own
// per-connection channel cap (host/ipc/modules/forward.ts): sized so
// one browser tab's ~6 keepalive sockets plus an HMR websocket fit
// with headroom. Per host process, so this count spans ALL forwards to
// one device, not each forward alone. A conn over the cap would be
// refused there anyway, but only after a full open round trip, so an
// accepted socket over the cap is destroyed immediately instead.
// Exported so the port-forward check's cap scenario tracks this value.
export const MAX_CONNS_PER_DEVICE = 16;

// Trailing coalesce for the changed signal: accepts and closes arrive
// in bursts (one page load moves ~a dozen conns), and each signal
// triggers a renderer list refetch, so burst members collapse into one
// signal shortly after the first.
const CHANGE_COALESCE_MS = 150;

export type PortForwardSummary = {
  forwardId: string;
  deviceId: string;
  remotePort: number;
  localPort: number;
  connCount: number;
};

type Forward = {
  forwardId: string;
  deviceId: string;
  remotePort: number;
  localPort: number;
  server: Server;
  conns: Set<BridgedConn>;
  api: ForwardApi;
  channels: PeerChannels;
};

export type PortForwardEngine = ReturnType<typeof createPortForwardEngine>;

export function createPortForwardEngine(deps: {
  forwardApiFor: (deviceId: string) => ForwardApi;
  // The peer session's byte channels (bridge.ts PeerChannels).
  channelsFor: (deviceId: string) => PeerChannels;
  onChange?: () => void;
}) {
  const forwards = new Map<string, Forward>();
  // The trailing debounce (CHANGE_COALESCE_MS above). unref'd so a
  // pending signal never holds the process open on quit.
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (deps.onChange === undefined || changeTimer !== null) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      deps.onChange?.();
    }, CHANGE_COALESCE_MS);
    changeTimer.unref?.();
  };

  function findForward(
    deviceId: string,
    remotePort: number,
  ): Forward | undefined {
    for (const forward of forwards.values()) {
      if (forward.deviceId === deviceId && forward.remotePort === remotePort) {
        return forward;
      }
    }
    return undefined;
  }

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
    const conn = bridgeSocket(socket, {
      channels: forward.channels,
      open: (channelId) =>
        forward.api.open({ port: forward.remotePort, channelId }),
      onClosed: () => {
        forward.conns.delete(conn);
        changed();
      },
    });
    forward.conns.add(conn);
    changed();
  }

  async function startForward(input: {
    deviceId: string;
    remotePort: number;
    localPort?: number;
  }): Promise<{ forwardId: string; localPort: number }> {
    // One forward per (deviceId, remotePort): starting an existing pair
    // returns it unchanged, unless the caller names a different local
    // port, which moves the listener there. The old listener stays up
    // until the new one is bound (below), so a move that fails (port
    // taken, peer gone) leaves the working forward exactly as it was.
    // Idempotent otherwise, the simpler contract for a UI whose start
    // doubles as "make sure this is forwarded".
    const existing = findForward(input.deviceId, input.remotePort);
    if (
      existing !== undefined &&
      (input.localPort === undefined || input.localPort === existing.localPort)
    ) {
      return { forwardId: existing.forwardId, localPort: existing.localPort };
    }
    const api = deps.forwardApiFor(input.deviceId);
    const channels = deps.channelsFor(input.deviceId);
    // Probe the remote service before binding anything: one channel
    // opened and reset at once, so a dead port, a revoked grant or an
    // offline peer rejects the start with its coded error instead of
    // minting a listener whose conns die on arrival.
    const probeMux = await channels();
    const probeId = mintHexId();
    const probe = probeMux.attach(probeId, {
      onData: (_data, consumed) => consumed(),
      onEnd: () => {},
      onReset: () => {},
      onWritable: () => {},
    });
    try {
      await api.open({ port: input.remotePort, channelId: probeId });
    } finally {
      probe.reset();
    }
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
    // the twin and release the just-bound listener. The forward being
    // moved is not a twin: it is what the new listener replaces, and
    // only now, with the replacement bound, does it go.
    const twin = findForward(input.deviceId, input.remotePort);
    if (twin !== undefined && twin !== existing) {
      server.close();
      return { forwardId: twin.forwardId, localPort: twin.localPort };
    }
    if (existing !== undefined) stopForward(existing.forwardId);
    const forward: Forward = {
      forwardId: mintHexId(),
      deviceId: input.deviceId,
      remotePort: input.remotePort,
      localPort,
      server,
      conns: new Set(),
      api,
      channels,
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
    for (const conn of forward.conns) conn.destroy();
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
