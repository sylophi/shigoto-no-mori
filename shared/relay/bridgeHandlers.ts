// Handlers for the renderer-facing relay bridge (v2 step 4, slice C).
// Thin by design: status reads the connection's snapshot, invokePeer
// forwards over the relay's client role, and the peer session cache
// lives here so the view layer never owns a connection the Durable
// Object would supersede. Pure aside from the injected deps (no
// electron, no node builtins), which is why both bindings share it:
// the Electron main process serves it over IPC (main/ipc/index.ts) and
// the web bridge serves it in-page (web/bridge/createWebBridge.ts).
import type { relayContract, RelayStatus } from "@shared/ipc/modules/relay";
import type { Handlers } from "@shared/ipc/types";
import type { ConnectPeerOpts, PeerConnection } from "@shared/relay/link";

export type RelayHandlerDeps = {
  status(): RelayStatus;
  connectPeer(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
};

export function makeRelayHandlers(
  deps: RelayHandlerDeps,
): Handlers<typeof relayContract> {
  // Peer sessions opened lazily on first use, cached by deviceId, and
  // dropped the moment they die (the link fires onClose on presence
  // drop, nack and socket teardown), so the next call redials with a
  // fresh sm hello. The map holds the promise, not the connection, so
  // concurrent first calls share one handshake.
  const peers = new Map<string, Promise<PeerConnection>>();

  function openPeer(deviceId: string): Promise<PeerConnection> {
    const existing = peers.get(deviceId);
    if (existing !== undefined) return existing;
    const promise = deps.connectPeer(deviceId, {
      onClose: () => peers.delete(deviceId),
    });
    peers.set(deviceId, promise);
    promise.catch(() => {
      // A failed handshake must not poison the cache, or the peer
      // would stay unreachable until restart.
      peers.delete(deviceId);
    });
    return promise;
  }

  return {
    status: () => deps.status(),

    invokePeer: async ({ deviceId, channel, input }) => {
      const peer = await openPeer(deviceId);
      // Offline, oversize and disconnect errors reject through here,
      // and their messages ride each wire's error serialization to the
      // renderer unchanged.
      return peer.transport.invoke(channel, input);
    },

    // The explicit ensure-session path (dial-on-subscribe): opens or
    // reuses the peer session WITHOUT invoking anything, so a
    // subscribe-only client still triggers the sm hello and starts
    // receiving that peer's pushes. Failures (offline, link down)
    // reject through so the caller can retry on the next reconnect.
    ensurePeer: async ({ deviceId }) => {
      await openPeer(deviceId);
    },

    peerInfo: async ({ deviceId }) => {
      const cached = peers.get(deviceId);
      if (cached === undefined) return null;
      try {
        const peer = await cached;
        return { appVersion: peer.remoteAppVersion };
      } catch {
        // The cached handshake failed. The catch above already evicted
        // it, so this reads as "no session".
        return null;
      }
    },
  };
}
