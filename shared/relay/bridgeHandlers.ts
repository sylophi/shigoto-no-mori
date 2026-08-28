// Handlers for the renderer-facing relay bridge (v2 step 4, slice C).
// Thin by design: status reads the connection's snapshot, invokePeer
// forwards over the cached peer session, and the session cache lives
// here so the view layer never owns a connection the remote host's
// supersede rule would kill. Pure aside from the injected deps (no
// electron, no node builtins), which is why both bindings share it:
// the Electron main process serves it over IPC (main/ipc/index.ts) and
// the web bridge serves it in-page (web/bridge/createWebBridge.ts).
//
// DIRECT OR NOTHING (v2 step 10, slice C): the session cache here is
// the single peer-session chokepoint every consumer shares (renderer
// invokes and subscriptions, sync, port-forward), and every session in
// it is a DIRECT websocket from the injected dialer. There is no relay
// fallback: a failed dial rejects with the dialer's typed error
// (NoDialableCandidateError for the structural
// nothing-this-platform-can-dial verdict, a transient error
// otherwise), and the entry drops. The relay rides underneath only as
// the dialer's broker transport (direct:connectInfo), never as a data
// path. The web bridge injects the same dialer with a wss-only
// candidate filter (v2 step 10, slice B): a browser page cannot dial
// ws:// from https (mixed content), but wss tunnel URLs dial fine.
//
// SUPERVISED, NOT LAZY (v2 step 11): dialPeer is the ONLY entry that
// starts a dial, and its only caller is the presence-driven keeper
// (shared/relay/directKeeper.ts, wired in directPlane.ts). The
// contract surface (invokePeer, the one channel left that touches a
// session) rides whatever session the keeper holds -- an invoke joins
// an in-flight dial but a cache miss rejects at once instead of
// dialing, so no user action is ever what triggers a dial and no
// renderer retry loop can pace one. The rejection folds in the
// keeper's last failure so the renderer surfaces the honest cause
// rather than a bare "not connected".
import type { relayContract, RelayStatus } from "@shared/ipc/modules/relay";
import type { Handlers } from "@shared/ipc/types";
import type { ConnectPeerOpts, PeerConnection } from "@shared/relay/directDial";

export type RelayHandlerDeps = {
  status(): RelayStatus;
  // The direct dial (shared/relay/directDial.ts), the ONLY way a peer
  // session comes to exist. The relay connection is not a dep here on
  // purpose: nothing in the bridge may open a relay peer session, so
  // the broker transport stays private to the dialer.
  connectDirect(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
  // Fired whenever a direct session is cached or a cached one drops,
  // so the owner can fan a fresh status snapshot out exactly like the
  // relay's own transitions.
  onDirectChange?: () => void;
  // Fired when an ESTABLISHED session dies on its own (the transport's
  // self-close): the keeper's redial signal. Owner-initiated closes
  // (roster sweep, quit) never fire it, or quit would schedule dials
  // against a host being torn down and a sweep would redial a peer the
  // control plane just disowned.
  onPeerDropped?: (deviceId: string) => void;
  // The keeper's explanation for a rostered peer with no session (its
  // last dial failure, cleared the moment a dial succeeds), folded
  // into the no-session rejection.
  peerUnavailableReason?: (deviceId: string) => string | null;
};

export type RelayHandlers = Handlers<typeof relayContract> & {
  // One dial attempt (or a join onto the cached session or in-flight
  // dial) for one peer. Not a contract channel: the keeper is its only
  // production caller, which is what makes sessions desired state
  // instead of use-triggered.
  dialPeer(deviceId: string): Promise<void>;
  // The appVersion each ESTABLISHED direct session's welcome
  // confirmed, keyed by deviceId. This is the whole per-peer data
  // surface: the owner folds it into RelayStatus.peerAppVersions, and
  // membership in it is what "has a direct session" means (the
  // renderer derives connectedness from the keys, and the skew check
  // reads the values).
  directPeerVersions(): Record<string, string>;
  // Close and drop the cached direct sessions for peers no longer in
  // the live roster: the client half of "presence scopes the data
  // plane", so a peer the control plane no longer vouches for loses
  // its direct wire too.
  dropDirectPeersNotIn(online: readonly string[]): void;
  // Close and drop every cached direct session, for the quit path:
  // without it the remote host keeps a dead socket in its per-device
  // slot and relaunch lands on the supersede path instead of a clean
  // reconnect. Owners do NOT call this -- directPlane.stop() owns
  // teardown, keeper latch first -- but it stays exported because the
  // direct-plane check tears its bare bridges down with it.
  closeDirectPeers(): void;
};

export function makeRelayHandlers(deps: RelayHandlerDeps): RelayHandlers {
  // Peer sessions opened by the keeper's dials, cached by deviceId,
  // and dropped the moment they die (the transport fires onClose on
  // its own failure mode), so the keeper's redial lands on an empty
  // slot and handshakes fresh. The entry holds the promise, not the
  // connection, so a dialPeer overlapping an in-flight dial shares one
  // handshake. The welcome's version
  // lives on the entry itself, set on the exact entry object the dial
  // belongs to (held lexically, never re-read from the map: a re-read
  // after an await could stamp a NEW entry if this one was dropped and
  // replaced mid-dial). A non-null version is also the established
  // marker directPeerVersions derives from, so a still-dialing entry
  // is never reported as a live session.
  type PeerEntry = {
    promise: Promise<PeerConnection>;
    version: string | null;
  };
  const peers = new Map<string, PeerEntry>();

  function dropPeer(
    deviceId: string,
    entry?: PeerEntry,
    selfClosed = false,
  ): void {
    const cached = peers.get(deviceId);
    if (cached === undefined) return;
    // When the caller names an entry, drop only that one: a stale
    // close callback must not evict the replacement session.
    if (entry !== undefined && cached !== entry) return;
    peers.delete(deviceId);
    // Only an actual transition notifies: dropping an entry whose dial
    // never completed changed nothing on the status surface. The
    // keeper hears about SELF-closes only (see onPeerDropped above),
    // and after the delete, so its redial finds an empty slot.
    if (cached.version !== null) {
      deps.onDirectChange?.();
      if (selfClosed) deps.onPeerDropped?.(deviceId);
    }
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
    // async chain below, so the version is stamped on exactly the
    // entry this dial owns, whatever the map holds by then. A failed
    // dial rejects THROUGH here untouched: the dialer's errors are
    // typed (structural vs transient) and user-explainable, and there
    // is deliberately nothing to fall back to.
    const entry: PeerEntry = {
      promise: undefined as unknown as Promise<PeerConnection>,
      version: null,
    };
    entry.promise = (async (): Promise<PeerConnection> => {
      const connection = await deps.connectDirect(deviceId, {
        onClose: () => dropPeer(deviceId, entry, true),
      });
      entry.version = connection.remoteAppVersion;
      // A dial can complete after a sweep already evicted this entry
      // (the peer left the roster mid-dial). The sweep's continuation
      // closes the connection, and an orphan must not fan a status
      // change out for a session the map never reports.
      if (peers.get(deviceId) === entry) deps.onDirectChange?.();
      return connection;
    })();
    peers.set(deviceId, entry);
    entry.promise.catch(() => {
      // A failed dial must not poison the cache, or the peer would
      // stay unreachable until restart even after its listener came
      // back.
      dropPeer(deviceId, entry);
    });
    return entry.promise;
  }

  // The keeper's session, or the honest refusal. A present entry may
  // still be an in-flight keeper dial: awaiting it is what makes an
  // invoke racing the eager dial seamless instead of flaky, and a
  // failed dial rejects the invoke with the dialer's typed error. A
  // MISS never dials (see the header): the peer is offline, or the
  // keeper is between attempts, and the rejection says which.
  function requirePeer(deviceId: string): Promise<PeerConnection> {
    const entry = peers.get(deviceId);
    if (entry === undefined) {
      const reason = deps.peerUnavailableReason?.(deviceId);
      return Promise.reject(
        new Error(
          `no direct connection to ${deviceId}` +
            (reason == null ? "" : ` (${reason})`),
        ),
      );
    }
    return entry.promise;
  }

  return {
    status: () => deps.status(),

    dialPeer: async (deviceId) => {
      await openPeer(deviceId);
    },

    invokePeer: async ({ deviceId, channel, input }) => {
      const peer = await requirePeer(deviceId);
      // Disconnect and no-session errors reject through here, and
      // their messages ride each wire's error serialization to the
      // renderer unchanged.
      return peer.transport.invoke(channel, input);
    },

    directPeerVersions: () => {
      const versions: Record<string, string> = {};
      for (const [deviceId, entry] of peers) {
        if (entry.version !== null) versions[deviceId] = entry.version;
      }
      return versions;
    },

    // Both sweeps below cover mid-dial entries too, not just
    // established sessions: a dial completing AFTER its peer left the
    // roster would otherwise install a live session for a device the
    // control plane stopped vouching for (including a just-revoked
    // one), and quit would leave an in-flight dial's socket unclosed.
    // closeDirectPeer handles both shapes: it evicts the entry now and
    // attaches a continuation that closes the resulting connection
    // whenever the promise settles (a rejection means there is nothing
    // to close).
    dropDirectPeersNotIn: (online) => {
      const live = new Set(online);
      for (const [deviceId, entry] of peers) {
        if (!live.has(deviceId)) closeDirectPeer(deviceId, entry);
      }
    },

    closeDirectPeers: () => {
      for (const [deviceId, entry] of peers) {
        closeDirectPeer(deviceId, entry);
      }
    },
  };
}
