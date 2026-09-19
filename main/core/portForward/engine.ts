// The client half of port forwarding (byte
// channels): binds loopback listeners on this machine and
// bridges each accepted socket onto a channel of the peer's direct
// session, opened with forward:open (the host side in
// host/ipc/modules/forward.ts, the wire rules in
// shared/ipc/modules/forward.ts). Electron-free on purpose, node:net
// plus injected dependencies, so the e2e check drives the real engine
// over a real device wire (test/port-forward.mjs) while
// main/ipc wires the peer reach over the bridge's shared direct
// sessions.
//
// The per-socket bridging (attach, open, the adapter's backpressure and
// teardown) lives in bridge.ts, shared with the mirror gateway. This
// file owns the listeners, the per-device conn cap and the forward
// registry.
import { coalesce } from "@host/lib/util/coalesce";
import { createServer, type Server, type Socket } from "node:net";
import {
  type forwardContract,
  isForwardConnectFailedError,
} from "@shared/ipc/modules/forward";
import type { Client } from "@shared/ipc/types";
import { mintHexId } from "@host/lib/idleRegistry";
import {
  type BridgedConn,
  bridgeSocket,
  listenLoopback,
  type PeerChannels,
} from "./bridge";

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

// Trailing coalesce for the changed signal: opens and closes arrive
// in bursts (one page load moves ~a dozen conns), and each signal
// triggers a renderer list refetch, so burst members collapse into one
// signal shortly after the first.
export const CHANGE_COALESCE_MS = 150;

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
  // Every accepted socket, for the cap and teardown.
  conns: Set<BridgedConn>;
  // The ones whose far end opened, which is what the summary counts: a
  // dial to a port with nothing behind it never shows as a conn.
  opened: Set<BridgedConn>;
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
  const changed = coalesce(() => deps.onChange?.(), CHANGE_COALESCE_MS);

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
      onOpened: () => {
        forward.opened.add(conn);
        changed();
      },
      onClosed: () => {
        forward.conns.delete(conn);
        if (forward.opened.delete(conn)) changed();
      },
    });
    forward.conns.add(conn);
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
    // Probe the peer before binding anything: one channel opened and
    // reset at once, so a revoked grant or an offline peer rejects the
    // start with its coded error instead of minting a listener whose
    // conns die on arrival. A port with nothing listening yet is NOT a
    // rejection: the forward is a standing intent, so it binds anyway
    // and each conn dials the port afresh, which means a dev server
    // started later is reached without touching the switch again. Until
    // then a local dial is accepted and closed, which a browser shows
    // as an empty response.
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
    } catch (error) {
      if (!isForwardConnectFailedError(error)) throw error;
    } finally {
      probe.reset();
    }
    // allowHalfOpen: a client FIN must not tear the conn down (the
    // adapter in host/socket/channelStreams.ts ends one direction and
    // keeps the other flowing), but node's default would auto-end the
    // writable side and drop the remote's response.
    const server = createServer({ allowHalfOpen: true });
    const localPort = await listenLoopback(server, input.localPort ?? 0);
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
      opened: new Set(),
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
      connCount: forward.opened.size,
    }));
  }

  // Shutdown teardown. Synchronous on the local side (listeners and
  // sockets die now), best-effort on the wire.
  function stopAll(): void {
    for (const forwardId of forwards.keys()) stopForward(forwardId);
  }

  return { startForward, stopForward, listForwards, stopAll };
}
