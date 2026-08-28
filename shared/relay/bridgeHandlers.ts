// Handlers for the renderer-facing relay bridge (v2 step 4, slice C).
// Thin by design: status reads the connection's snapshot, invokePeer
// forwards over the relay's client role, and the peer session cache
// lives here so the view layer never owns a connection the Durable
// Object would supersede. Pure aside from the injected deps (no
// electron, no node builtins), which is why both bindings share it:
// the Electron main process serves it over IPC (main/ipc/index.ts) and
// the web bridge serves it in-page (web/bridge/createWebBridge.ts).
//
// DIRECT-FIRST ROUTING (v2 step 10, slice A): openPeer is the single
// peer-session chokepoint every consumer shares (renderer invokes and
// subscriptions, sync, port-forward), so the direct data plane plugs
// in exactly here. When the owner injects connectDirect, a cache miss
// tries the direct dial first and falls back to the relay on ANY
// direct failure. Whichever succeeded is cached, and a close drops the
// cache entry as before, so the next use redials and re-decides. The
// web bridge injects nothing and keeps relay-only behavior (a browser
// page cannot dial ws:// from https anyway).
import type { relayContract, RelayStatus } from "@shared/ipc/modules/relay";
import type { Handlers } from "@shared/ipc/types";
import type { ConnectPeerOpts, PeerConnection } from "@shared/relay/link";

export type RelayHandlerDeps = {
  status(): RelayStatus;
  connectPeer(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
  // The direct dial (shared/relay/directDial.ts), tried before the
  // relay when present. Same opts shape as connectPeer so the cache's
  // close wiring is identical on both paths.
  connectDirect?: (
    deviceId: string,
    opts?: ConnectPeerOpts,
  ) => Promise<PeerConnection>;
  // Fired whenever a cached session becomes or stops being direct, so
  // the owner can fan a fresh status snapshot out exactly like the
  // relay's own transitions.
  onDirectChange?: () => void;
};

export type RelayHandlers = Handlers<typeof relayContract> & {
  // The deviceIds whose CACHED peer session is a direct socket, for
  // the status surface (RelayStatus.directDeviceIds).
  directPeerIds(): string[];
  // The appVersion each direct session's welcome confirmed, keyed by
  // deviceId, so the owner can fold direct peers into the same
  // peerAppVersions snapshot the relay's client peers feed. Without
  // this a direct-connected peer would report an empty version and the
  // renderer's skew check would never fire for exactly the peers on
  // the best wire.
  directPeerVersions(): Record<string, string>;
  // Close and drop the cached DIRECT sessions for peers no longer in
  // the live roster. Relay sessions need no equivalent (the link's own
  // presence reconcile destroys them), so this is the client half of
  // "presence scopes the data plane": a peer the control plane no
  // longer vouches for loses its direct wire too.
  dropDirectPeersNotIn(online: readonly string[]): void;
  // Close and drop every cached direct session, for the quit path:
  // without it the remote host keeps a dead socket in its per-device
  // slot and relaunch lands on the supersede path instead of a clean
  // reconnect.
  closeDirectPeers(): void;
};

export function makeRelayHandlers(deps: RelayHandlerDeps): RelayHandlers {
  // Peer sessions opened lazily on first use, cached by deviceId, and
  // dropped the moment they die (each transport fires onClose on its
  // own failure mode), so the next call redials with a fresh
  // handshake. The entry holds the promise, not the connection, so
  // concurrent first calls share one handshake. The direct flag and
  // the welcome's version live on the entry itself, set on the exact
  // entry object the dial belongs to (held lexically, never re-read
  // from the map: a re-read after an await could stamp a NEW relay
  // entry direct if this one was dropped and replaced mid-dial), so
  // directPeerIds derives from the cache instead of a parallel set.
  type PeerEntry = {
    promise: Promise<PeerConnection>;
    direct: boolean;
    version: string | null;
  };
  const peers = new Map<string, PeerEntry>();

  function dropPeer(deviceId: string, entry?: PeerEntry): void {
    const cached = peers.get(deviceId);
    if (cached === undefined) return;
    // When the caller names an entry, drop only that one: a stale
    // close callback must not evict the replacement session.
    if (entry !== undefined && cached !== entry) return;
    peers.delete(deviceId);
    // Only an actual transition notifies: dropping a relay entry never
    // changed the direct surface.
    if (cached.direct) deps.onDirectChange?.();
  }

  // Close a cached direct session and drop its entry. The transports'
  // owner-initiated close is deliberately silent (no onClose), so the
  // drop happens here rather than waiting on a callback.
  function closeDirectPeer(deviceId: string, entry: PeerEntry): void {
    dropPeer(deviceId, entry);
    entry.promise
      .then((connection) => {
        connection.close();
      })
      .catch(() => {
        // The handshake failed on its own. Nothing to close.
      });
  }

  function openPeer(deviceId: string): Promise<PeerConnection> {
    const existing = peers.get(deviceId);
    if (existing !== undefined) return existing.promise;
    // The entry object is created first and held lexically by the
    // async chain below, so the direct flag is stamped on exactly the
    // entry this dial owns, whatever the map holds by then.
    const entry: PeerEntry = {
      promise: undefined as unknown as Promise<PeerConnection>,
      direct: false,
      version: null,
    };
    entry.promise = (async (): Promise<PeerConnection> => {
      if (deps.connectDirect !== undefined) {
        try {
          const connection = await deps.connectDirect(deviceId, {
            onClose: () => dropPeer(deviceId, entry),
          });
          entry.direct = true;
          entry.version = connection.remoteAppVersion;
          deps.onDirectChange?.();
          return connection;
        } catch {
          // ANY direct failure (no listener, unreachable candidates, a
          // spent ticket, an identity mismatch) falls back to the
          // relay. The next redial re-decides from scratch.
        }
      }
      return deps.connectPeer(deviceId, {
        onClose: () => dropPeer(deviceId, entry),
      });
    })();
    peers.set(deviceId, entry);
    entry.promise.catch(() => {
      // A failed handshake must not poison the cache, or the peer
      // would stay unreachable until restart.
      dropPeer(deviceId, entry);
    });
    return entry.promise;
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
        const peer = await cached.promise;
        return { appVersion: peer.remoteAppVersion };
      } catch {
        // The cached handshake failed. The catch above already evicted
        // it, so this reads as "no session".
        return null;
      }
    },

    directPeerIds: () =>
      [...peers]
        .filter(([, entry]) => entry.direct)
        .map(([deviceId]) => deviceId)
        .sort(),

    directPeerVersions: () => {
      const versions: Record<string, string> = {};
      for (const [deviceId, entry] of peers) {
        if (entry.direct && entry.version !== null) {
          versions[deviceId] = entry.version;
        }
      }
      return versions;
    },

    dropDirectPeersNotIn: (online) => {
      const live = new Set(online);
      for (const [deviceId, entry] of peers) {
        if (entry.direct && !live.has(deviceId)) {
          closeDirectPeer(deviceId, entry);
        }
      }
    },

    closeDirectPeers: () => {
      for (const [deviceId, entry] of peers) {
        if (entry.direct) closeDirectPeer(deviceId, entry);
      }
    },
  };
}
