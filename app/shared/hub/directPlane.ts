// The direct data plane over one hub connection: the dialer, the
// renderer-facing bridge, the keeper (directKeeper.ts) and the presence
// reconcile (directPresence.ts). Data is direct or nothing: the bridge
// never sees the connection, and the one question the dialer puts to
// it is a peer's connect info. The host (host/process/wires.ts) and the
// web bridge (web/ipc/register.ts) differ only by these deps.
//
// Pure aside from the injected deps (no electron, no node builtins). It
// lives as long as the scope it is made in (quit, a tab's teardown).

import type { KeyPair } from "@shared/crypto/noise";
import type { DeviceKind } from "@shigomori/contracts/modules/link";
import { callOf, channelOf, payloadOf } from "@shigomori/contracts/contract";
import { accountContract } from "@shigomori/contracts/modules/account";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { safeDecode } from "@shigomori/contracts/codec";
import type { DirectCandidateKind } from "@shigomori/contracts/modules/direct";
import type { HubPeerPush, HubStatus } from "@shigomori/contracts/modules/hub";
import type { HubConnectionStatus } from "@shared/hub/connectionTypes";
import { makeHubHandlers, type HubHandlers } from "@shared/hub/bridgeHandlers";
import { createDirectDialer, type DirectDialer } from "@shared/hub/directDial";
import * as DirectKeeper from "@shared/hub/directKeeper";
import { applyDirectPresence } from "@shared/hub/directPresence";
import type { OpenClientSocket } from "@shared/remote/deviceLink";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

// The peer's command-access switch flipping, as its direct listener
// pushes it. The bridge records it on the peer's session so the status
// snapshot's peerAcceptsCommands follows the switch live.
const COMMAND_ACCESS_CHANGED = callOf(accountContract, "commandAccessChanged");
// The peer's sharing switch flipping, kept the same way as
// peerSharesData.
const SHARING_CHANGED = callOf(sharingContract, "changed");

// The slice of a hub connection the plane composes over, common to
// the node connection (host/hub/connection.ts) and the browser one
// (web/hub/connection.ts).
type DirectPlaneConnection = {
  status(): HubConnectionStatus;
  localKey(): KeyPair | null;
  peerKey(deviceId: string): Uint8Array | undefined;
  askConnectInfo(
    deviceId: string,
    input: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

export type DirectPlaneDeps = {
  // The hub connection, as a getter because the owner wires the
  // connection's own callbacks to the plane it creates first, so the
  // binding must resolve lazily.
  connection(): DirectPlaneConnection;
  // Identity facts, as getters because the host's deviceId and appVersion
  // are post-boot facts read on first dial, not at wiring time.
  localDeviceId(): string;
  localAppVersion(): string;
  // The owner's fan-out sinks: every window the host serves, the tab's
  // own wire in the browser.
  broadcastStatus(status: HubStatus): void;
  broadcastPeerPush(push: HubPeerPush): void;
  // The candidate kinds this platform can dial (directDial.ts). The
  // web bridge declares ["tunnel"], the app takes the dialer's
  // race-everything default.
  dialableKinds?: ReadonlyArray<DirectCandidateKind>;
  // What this device is (directDial.ts): the web bridge says "web".
  deviceKind?: DeviceKind;
  // The candidate sockets' constructor (directDial.ts). The host
  // injects the `ws` package so a failed dial names its
  // errno. The web bridge and the checks take the platform global.
  openSocket?: OpenClientSocket;
  // The dialer's deadline for each leg of an attempt. A check seam: the
  // fixtures shrink it so failure scenarios settle fast, real owners
  // omit it and take the dialer's HELLO_TIMEOUT_MS default.
  deadlineMs?: number;
  // The host half, absent on platforms that only ever dial out: the
  // direct listener's targeted roster close, and this device's own
  // tunnel endpoint state for the status snapshot.
  host?: {
    closeHostPeersNotIn(online: readonly string[]): void;
    tunnelState(): NonNullable<HubStatus["tunnel"]>;
  };
};

export type DirectPlane = {
  // The renderer-facing hub bridge, for the contract registration.
  // Teardown is the plane's scope closing, not a call in here.
  handlers: HubHandlers;
  // The status snapshot: the connection's own status plus the direct
  // surface (peerAppVersions, whose keys are the live direct sessions,
  // and peerAcceptsCommands) plus the host half's tunnel state.
  status(): HubStatus;
  // Fan a fresh snapshot out, for owner-side transitions outside the
  // connection (the host's tunnel runner state changes).
  notifyStatusChanged(): void;
  // Wire this to the connection's onChange: it fans the fresh snapshot
  // out and reconciles direct-session presence (the sweeps and the
  // keeper's desired set), reading the connection's status once for
  // both.
  handleConnectionChange(): void;
  // The wake-time liveness probe for every established direct session
  // (bridgeHandlers.ts probeDirectPeers), and a dial now for every peer
  // waiting out the keeper's ladder. Owners fire it beside the hub
  // connection's own probe when the machine resumes, the page comes
  // back or the network does, so both planes get their verdict in
  // seconds.
  probe(): void;
};

// The plane, until its scope closes, which latches the keeper and then
// closes every cached direct session.
export const make = (
  deps: DirectPlaneDeps,
): Effect.Effect<DirectPlane, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Created lazily because it captures the identity facts.
    let dialer: DirectDialer | null = null;
    function getDialer(): DirectDialer {
      dialer ??= createDirectDialer({
        askConnectInfo: (deviceId, input, timeoutMs, signal) =>
          deps.connection().askConnectInfo(deviceId, input, timeoutMs, signal),
        localDeviceId: deps.localDeviceId(),
        localAppVersion: deps.localAppVersion(),
        localKey: () => deps.connection().localKey(),
        peerKey: (deviceId) => deps.connection().peerKey(deviceId),
        // Pushes received on a direct connection are the only peer
        // pushes there are (the device hub carries none).
        onAnyPush: (deviceId, channel, payload) => {
          if (channel === channelOf(COMMAND_ACCESS_CHANGED)) {
            const accepts = safeDecode(
              payloadOf(COMMAND_ACCESS_CHANGED),
              payload,
            );
            if (accepts.success) {
              handlers.setPeerFact(deviceId, "acceptsCommands", accepts.data);
            }
          }
          if (channel === channelOf(SHARING_CHANGED)) {
            const shares = safeDecode(payloadOf(SHARING_CHANGED), payload);
            if (shares.success) {
              handlers.setPeerFact(deviceId, "sharesData", shares.data);
            }
          }
          deps.broadcastPeerPush({ deviceId, channel, payload });
        },
        dialableKinds: deps.dialableKinds,
        deviceKind: deps.deviceKind,
        openSocket: deps.openSocket,
        deadlineMs: deps.deadlineMs,
      });
      return dialer;
    }

    function buildStatus(current: HubConnectionStatus): HubStatus {
      return {
        socket: current.socket,
        onlineDeviceIds: current.onlineDeviceIds,
        // Each established direct session's version, command access
        // and sharing. peerAppVersions' keys are the direct-session set
        // (the renderer derives connectedness from them).
        ...handlers.directPeers(),
        // This device's tunnel state, never its hostname or token.
        // Absent without a host half (the web bridge runs no
        // cloudflared).
        ...(deps.host === undefined ? {} : { tunnel: deps.host.tunnelState() }),
      };
    }

    function status(): HubStatus {
      return buildStatus(deps.connection().status());
    }

    function notifyStatusChanged(): void {
      deps.broadcastStatus(status());
    }

    const handlers: HubHandlers = yield* makeHubHandlers({
      status,
      connectDirect: (deviceId) => getDialer().connectDirect(deviceId),
      onDirectChange: notifyStatusChanged,
      // The keeper's redial signal and its no-session explanation. Both
      // close over the binding below (created after the handlers because
      // the keeper's dial is dialPeer), which is resolved lazily and
      // only ever fires after creation.
      onPeerDropped: (deviceId) => keeper.peerDropped(deviceId),
      peerUnavailableReason: (deviceId) => keeper.unavailableReason(deviceId),
    });

    // The close's two halves, in the order that matters: registered
    // first, so the sessions close once the keeper (whose scope closes
    // first) is latched. The keeper supervises a session per rostered
    // peer with pending redial timers, and an unlatched timer firing
    // during the close would dial fresh sessions into a teardown.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => handlers.closeDirectPeers()),
    );

    const keeper: DirectKeeper.DirectKeeper = yield* DirectKeeper.make({
      dial: (deviceId) => handlers.dialPeer(deviceId),
    });

    return {
      handlers,
      status,
      notifyStatusChanged,
      handleConnectionChange: () => {
        const current = deps.connection().status();
        deps.broadcastStatus(buildStatus(current));
        // The rule, its outage gate included, is directPresence.ts's.
        const host = deps.host;
        applyDirectPresence(current.socket, current.onlineDeviceIds, {
          closeHostPeersNotIn:
            host === undefined
              ? undefined
              : (online) => host.closeHostPeersNotIn(online),
          dropClientPeersNotIn: (online) =>
            handlers.dropDirectPeersNotIn(online),
          reconcilePeers: (online) => keeper.reconcile(online),
        });
      },
      probe: () => {
        handlers.probeDirectPeers();
        keeper.dialNow();
      },
    } satisfies DirectPlane;
  });
