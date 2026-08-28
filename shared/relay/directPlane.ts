// The direct data plane's shared composition (v2 step 10): one relay
// connection, the direct dialer tried before it, the renderer-facing
// bridge handlers, the status snapshot that folds the direct-session
// surface into the connection's own, and the presence reconcile that
// scopes direct sessions to a live roster. Both owners (the Electron
// main process in main/ipc/register.ts and the web bridge in
// web/bridge/createWebBridge.ts) used to hand-assemble exactly this
// and keep each other in step by comment. Now they differ only by the
// deps here: identity facts, the fan-out sink, the dialable candidate
// kinds, and the optional host half (a browser runs no direct
// listener, no cloudflared).
//
// Pure aside from the injected deps (no electron, no node builtins),
// like the pieces it composes.
import type { DirectCandidateKind } from "@shared/ipc/modules/direct";
import type { RelayPeerPush, RelayStatus } from "@shared/ipc/modules/relay";
import type { ConnectPeerOpts, PeerConnection } from "@shared/relay/link";
import type { RelayConnectionStatus } from "@shared/relay/connectionTypes";
import {
  makeRelayHandlers,
  type RelayHandlers,
} from "@shared/relay/bridgeHandlers";
import {
  createDirectDialer,
  type DirectDialer,
} from "@shared/relay/directDial";
import { applyDirectPresence } from "@shared/relay/directPresence";

// The slice of a relay connection the plane composes over, common to
// the node connection (host/relay/connection.ts) and the browser one
// (web/relay/connection.ts).
export type DirectPlaneConnection = {
  status(): RelayConnectionStatus;
  connectPeer(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
};

export type DirectPlaneDeps = {
  // The relay connection, as a getter because the owner wires the
  // connection's own callbacks to the plane it creates first, so the
  // binding must resolve lazily.
  connection(): DirectPlaneConnection;
  // Identity facts, as getters because main's deviceId and appVersion
  // are post-boot facts (getDeviceId, app.getVersion) read on first
  // dial, not at wiring time.
  localDeviceId(): string;
  localAppVersion(): string;
  // The owner's fan-out sinks: every window on the Electron binding,
  // the loopback wire in the browser.
  broadcastStatus(status: RelayStatus): void;
  broadcastPeerPush(push: RelayPeerPush): void;
  // The candidate kinds THIS platform can dial (directDial.ts). The
  // web bridge declares ["tunnel"], the app takes the dialer's
  // race-everything default.
  dialableKinds?: ReadonlyArray<DirectCandidateKind>;
  // The host half, absent on platforms that only ever dial out: the
  // direct listener's targeted roster close, and this device's own
  // tunnel endpoint state for the status snapshot.
  host?: {
    closeHostPeersNotIn(online: readonly string[]): void;
    tunnelState(): NonNullable<RelayStatus["tunnel"]>;
  };
};

export type DirectPlane = {
  // The renderer-facing relay bridge, for the contract registration
  // and the owner's teardown calls (closeDirectPeers on quit).
  handlers: RelayHandlers;
  // The status snapshot: the connection's own status plus the direct
  // surface (directDeviceIds, merged peerAppVersions) plus the host
  // half's tunnel state. The one shape the status handler and every
  // statusChanged fan-out report.
  status(): RelayStatus;
  // Fan a fresh snapshot out, for owner-side transitions outside the
  // connection (main's tunnel runner state changes).
  notifyStatusChanged(): void;
  // Wire this to the connection's onChange: it fans the fresh snapshot
  // out AND reconciles direct-session presence, reading the
  // connection's status once for both.
  handleConnectionChange(): void;
  // Wire this to the connection's onPeerPush.
  handlePeerPush(deviceId: string, channel: string, payload: unknown): void;
};

export function createDirectPlane(deps: DirectPlaneDeps): DirectPlane {
  // The dialer is stateful (the per-peer failure memo), so ONE
  // instance, created lazily because it captures the identity facts.
  let dialer: DirectDialer | null = null;
  function getDialer(): DirectDialer {
    dialer ??= createDirectDialer({
      connectRelayPeer: (deviceId) => deps.connection().connectPeer(deviceId),
      localDeviceId: deps.localDeviceId(),
      localAppVersion: deps.localAppVersion(),
      // Pushes received on a direct connection feed the SAME peerPush
      // fan-out the relay feeds, tagged with the peer's deviceId, so
      // the renderer's subscriber registry cannot tell the wires
      // apart.
      onAnyPush: (deviceId, channel, payload) => {
        deps.broadcastPeerPush({ deviceId, channel, payload });
      },
      dialableKinds: deps.dialableKinds,
    });
    return dialer;
  }

  function buildStatus(current: RelayConnectionStatus): RelayStatus {
    const snapshot: RelayStatus = {
      socket: current.socket,
      onlineDeviceIds: current.onlineDeviceIds,
      // Folded into the snapshot so the renderer stops polling
      // peerInfo per device on every reconcile (M3). The connection
      // only knows its own client peers, so direct sessions merge
      // their welcome-confirmed versions in here, or the skew check
      // would silently never fire for exactly the peers on the best
      // wire.
      peerAppVersions: {
        ...current.peerAppVersions,
        ...handlers.directPeerVersions(),
      },
      directDeviceIds: handlers.directPeerIds(),
    };
    // THIS device's tunnel endpoint state (v2 step 10, slice B). The
    // state only, never the hostname or token. Absent without a host
    // half (the web bridge runs no cloudflared). Slice C revisits the
    // status surface, so until then tunnel state rides RelayStatus.
    if (deps.host !== undefined) snapshot.tunnel = deps.host.tunnelState();
    return snapshot;
  }

  function status(): RelayStatus {
    return buildStatus(deps.connection().status());
  }

  function notifyStatusChanged(): void {
    deps.broadcastStatus(status());
  }

  // openPeer routes direct-first with relay fallback (v2 step 10,
  // slice A), and a direct session opening or closing fires the same
  // statusChanged fan-out a relay transition does so the snapshot
  // stays live.
  const handlers = makeRelayHandlers({
    status,
    connectPeer: (deviceId, opts) =>
      deps.connection().connectPeer(deviceId, opts),
    connectDirect: (deviceId, opts) =>
      getDialer().connectDirect(deviceId, opts),
    onDirectChange: notifyStatusChanged,
  });

  return {
    handlers,
    status,
    notifyStatusChanged,
    handleConnectionChange: () => {
      // One status read serves both halves of a connection transition:
      // the statusChanged fan-out and the presence reconcile.
      const current = deps.connection().status();
      deps.broadcastStatus(buildStatus(current));
      // Presence scopes the data plane: on every relay transition,
      // close direct sessions for peers no longer in a LIVE roster and
      // clear the dialer's failure memo for peers that just came
      // online. The rule itself (including the
      // do-nothing-when-our-relay-is-down gate) lives in
      // directPresence.ts, where the direct-plane check pins it. The
      // host half is narrowed once here, so its absence (the web
      // bridge) passes plain undefined through.
      const host = deps.host;
      applyDirectPresence(
        current.socket.phase === "connected",
        current.onlineDeviceIds,
        {
          closeHostPeersNotIn:
            host === undefined
              ? undefined
              : (online) => host.closeHostPeersNotIn(online),
          dropClientPeersNotIn: (online) =>
            handlers.dropDirectPeersNotIn(online),
          notePresence: (online) => dialer?.notePresence(online),
        },
      );
    },
    handlePeerPush: (deviceId, channel, payload) => {
      deps.broadcastPeerPush({ deviceId, channel, payload });
    },
  };
}
