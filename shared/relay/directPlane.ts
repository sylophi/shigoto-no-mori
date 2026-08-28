// The direct data plane's shared composition (v2 step 10): one relay
// connection serving as the dialer's broker transport, the direct
// dialer, the renderer-facing bridge handlers, the keeper that
// supervises a direct session per rostered peer (v2 step 11: eager,
// forever-retry, presence as desired state -- directKeeper.ts), the
// status snapshot that folds the direct-session surface into the
// connection's own, and the presence reconcile that both scopes direct
// sessions to a live roster and feeds that roster to the keeper.
// Data is direct or nothing (slice C): the relay connection is handed
// to the DIALER only, never to the bridge, so no code path here can
// open a relay peer session for contract traffic. Both owners (the
// Electron main process in main/ipc/register.ts and the web bridge in
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
import type { RelayBrokerSession } from "@shared/relay/link";
import type { RelayConnectionStatus } from "@shared/relay/connectionTypes";
import {
  makeRelayHandlers,
  type RelayHandlers,
} from "@shared/relay/bridgeHandlers";
import {
  createDirectDialer,
  type DirectDialer,
} from "@shared/relay/directDial";
import {
  createDirectKeeper,
  type DirectKeeper,
} from "@shared/relay/directKeeper";
import { applyDirectPresence } from "@shared/relay/directPresence";
import type { SupervisorClock } from "@shared/remote/supervisor";

// The slice of a relay connection the plane composes over, common to
// the node connection (host/relay/connection.ts) and the browser one
// (web/relay/connection.ts). connectBroker resolves the NARROWED
// broker session (one typed invoke plus close) and is consumed by the
// dialer's broker leg ONLY (see createDirectPlane below).
export type DirectPlaneConnection = {
  status(): RelayConnectionStatus;
  connectBroker(deviceId: string): Promise<RelayBrokerSession>;
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
  // The dialer's overall attempt deadline. A check seam: the fixtures
  // shrink it so failure scenarios settle fast, real owners omit it
  // and take the dialer's HELLO_TIMEOUT_MS default.
  deadlineMs?: number;
  // The keeper's clock, a check seam too: the direct-plane check
  // drives retries with a fake clock instead of sleeping the real
  // ladder out. Real owners omit it and take real time.
  keeper?: { clock?: SupervisorClock };
  // The host half, absent on platforms that only ever dial out: the
  // direct listener's targeted roster close, and this device's own
  // tunnel endpoint state for the status snapshot.
  host?: {
    closeHostPeersNotIn(online: readonly string[]): void;
    tunnelState(): NonNullable<RelayStatus["tunnel"]>;
  };
};

export type DirectPlane = {
  // The renderer-facing relay bridge, for the contract registration.
  // Teardown is stop() below, not a call in here.
  handlers: RelayHandlers;
  // The status snapshot: the connection's own status plus the direct
  // surface (peerAppVersions, whose keys are the live direct sessions)
  // plus the host half's tunnel state. The one shape the status
  // handler and every statusChanged fan-out report.
  status(): RelayStatus;
  // Fan a fresh snapshot out, for owner-side transitions outside the
  // connection (main's tunnel runner state changes).
  notifyStatusChanged(): void;
  // Wire this to the connection's onChange: it fans the fresh snapshot
  // out AND reconciles direct-session presence (the sweeps and the
  // keeper's desired set), reading the connection's status once for
  // both.
  handleConnectionChange(): void;
  // Tears the whole plane down (quit, tab teardown): latches the
  // keeper, then closes every cached direct session. The ORDER is the
  // point and it lives here rather than in each owner: the keeper
  // supervises a session per rostered peer with pending redial timers,
  // and an unlatched timer firing during the close would dial fresh
  // sessions into a teardown. Owners call this alone -- both halves
  // are here, so neither can forget one.
  stop(): void;
};

export function createDirectPlane(deps: DirectPlaneDeps): DirectPlane {
  // ONE dialer instance, created lazily because it captures the
  // identity facts.
  let dialer: DirectDialer | null = null;
  function getDialer(): DirectDialer {
    dialer ??= createDirectDialer({
      // The ONLY consumer of the relay's client role: the broker leg
      // that asks a peer for its connect info. The bridge below never
      // sees connectBroker, and the session it resolves carries one
      // typed invoke only, so contract traffic structurally cannot
      // ride the relay.
      connectBroker: (deviceId) => deps.connection().connectBroker(deviceId),
      localDeviceId: deps.localDeviceId(),
      localAppVersion: deps.localAppVersion(),
      // Pushes received on a direct connection are the ONLY peer
      // pushes there are (the relay carries none), tagged with the
      // peer's deviceId and fanned through the owner's peerPush sink
      // so the renderer's subscriber registry stays wire-agnostic.
      onAnyPush: (deviceId, channel, payload) => {
        deps.broadcastPeerPush({ deviceId, channel, payload });
      },
      dialableKinds: deps.dialableKinds,
      deadlineMs: deps.deadlineMs,
    });
    return dialer;
  }

  function buildStatus(current: RelayConnectionStatus): RelayStatus {
    const snapshot: RelayStatus = {
      socket: current.socket,
      onlineDeviceIds: current.onlineDeviceIds,
      // Folded into the snapshot so the renderer stops polling
      // peerInfo per device on every reconcile (M3). Every data
      // session is direct now, so the direct sessions'
      // welcome-confirmed versions are the whole surface, and
      // membership here IS the direct-session set (the renderer
      // derives connectedness from the keys).
      peerAppVersions: handlers.directPeerVersions(),
    };
    // THIS device's tunnel endpoint state (v2 step 10, slice B). The
    // state only, never the hostname or token. Absent without a host
    // half (the web bridge runs no cloudflared). RelayStatus is the
    // remote-plane snapshot (relay control plane plus the direct data
    // plane it brokers), which is why the tunnel and direct surfaces
    // ride it.
    if (deps.host !== undefined) snapshot.tunnel = deps.host.tunnelState();
    return snapshot;
  }

  function status(): RelayStatus {
    return buildStatus(deps.connection().status());
  }

  function notifyStatusChanged(): void {
    deps.broadcastStatus(status());
  }

  // openPeer is direct or nothing (v2 step 10, slice C): the bridge
  // gets the dialer and nothing else, and a direct session opening or
  // closing fires the same statusChanged fan-out a relay transition
  // does so the snapshot stays live.
  const handlers = makeRelayHandlers({
    status,
    connectDirect: (deviceId, opts) =>
      getDialer().connectDirect(deviceId, opts),
    onDirectChange: notifyStatusChanged,
    // The keeper's redial signal and its no-session explanation. Both
    // close over the binding below (created after the handlers because
    // the keeper's dial IS dialPeer), which is resolved lazily and
    // only ever fires after creation.
    onPeerDropped: (deviceId) => keeper.peerDropped(deviceId),
    peerUnavailableReason: (deviceId) => keeper.unavailableReason(deviceId),
  });

  // The supervisor of the data plane (v2 step 11): the ONLY caller of
  // dialPeer, so every direct session exists because presence said the
  // device does, never because a renderer asked.
  const keeper: DirectKeeper = createDirectKeeper({
    dial: (deviceId) => handlers.dialPeer(deviceId),
    ...deps.keeper,
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
      // hand the roster to the keeper as its desired set (which dials
      // newly present peers at once). The rule itself (including the
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
          reconcilePeers: (online) => keeper.reconcile(online),
        },
      );
    },
    stop: () => {
      keeper.stop();
      handlers.closeDirectPeers();
    },
  };
}
