// Producer for the remote device registry (v2 step 4, slice C).
// Rebuilds the store from the account's device registry plus the relay
// bridge's live status, on boot, on account changes and on every relay
// statusChanged broadcast. There is no per-device
// supervisor here: the one relay socket lives in main, so a relay
// device's status DERIVES from the bridge instead of being driven.
//
// Status mapping, chosen to lie the least given the
// RemoteDeviceStatus vocabulary:
//   - relay socket not connected: mirror the socket's supervisor phase
//     (connecting, backoff, blocked and so on), because no peer is
//     reachable while the socket is down and the socket's state is the
//     honest reason.
//   - socket connected, the peer in the presence roster AND a direct
//     session established (a peerAppVersions key): phase "connected"
//     with the appVersion the session's welcome confirmed. Data is
//     direct or nothing (v2 step 10, slice C), so an established
//     direct session is the only thing "connected" may mean.
//   - socket connected, the peer in the roster, no direct session:
//     phase "online" (renderer-local). The roster fact shows, nothing
//     claims a data wire, and main's keeper is already dialing or
//     backing off toward one (sessions are supervised desired state),
//     so the normal resolution is the next snapshot flipping the
//     device to "connected" with no action here.
//   - socket connected but the peer absent from the roster: phase
//     "stopped", which renders as the neutral slate "Off" dot. "idle"
//     would render as "Connecting" (a lie, nothing is trying) and
//     "blocked" as a rose error (alarming for a machine that is simply
//     switched off), so the slate "Off" is the least-lying option.
import type { QueryClient } from "@tanstack/react-query";
import { buildApi } from "@shared/ipc/client";
import type { RelayStatus } from "@shared/ipc/modules/relay";
import type { DeviceInfo } from "@shared/relay/protocol";
import {
  publishRelayStatus,
  seedRelayStatus,
} from "@/hooks/remote/useRelayStatus";
import { invalidateDeviceSession } from "@/lib/queryKeys";
import {
  rejectingClientTransport,
  type RemoteDevice,
  type RemoteDeviceApi,
  type RemoteDeviceStatus,
  setRemoteDevices,
} from "./devices";
import { createRelayClientTransport } from "./relayTransport";

// The account device list, cached so presence and backoff transitions
// rebuild statuses without hitting the relay's HTTP endpoint every
// time. Refetched when unknown, on account changes, and when the
// socket transitions into connected (a reconnect may follow an enroll
// or revoke elsewhere).
let cachedList: DeviceInfo[] | null = null;
let lastSocketPhase = "";

// One api per relay deviceId, built on first reachable sighting and
// kept: the transport forwards through the bridge, whose session for
// that peer is supervised desired state (main's keeper redials it
// forever), so the api never goes stale the way a dead socket does.
const apis = new Map<string, RemoteDeviceApi>();

// The query client of the boot that started the sync, for the
// convergence invalidation below.
let boundQueryClient: QueryClient | null = null;

// The phase each device was last published with, so a reconcile can
// spot the ONE transition that needs a nudge: online to connected.
const lastPhases = new Map<string, RemoteDeviceStatus["phase"]>();

// Coalesce reconciles to latest-wins: presence events can arrive faster
// than a reconcile drains, and an unbounded promise chain would grow one
// pending link per event. A single in-flight run plus a dirty latch
// reruns once with the newest status when work piles up (M3).
let inFlight = false;
let dirty = false;
let queuedStatus: RelayStatus | undefined;

function apiFor(deviceId: string): RemoteDeviceApi {
  const existing = apis.get(deviceId);
  if (existing !== undefined) return existing;
  const api = buildApi({
    host: createRelayClientTransport(deviceId),
    client: rejectingClientTransport,
  });
  apis.set(deviceId, api);
  return api;
}

async function reconcileNow(status?: RelayStatus): Promise<void> {
  const current = status ?? (await window.api.relay.status());
  // A fetched snapshot seeds the shared store (a broadcast that raced
  // it is newer and wins), so this module stays the store's single
  // writer and the hooks never race a fetch of their own.
  if (status === undefined) seedRelayStatus(current);
  const phase = current.socket.phase;
  const localDeviceId = window.api.deviceId;
  const online = new Set(current.onlineDeviceIds);
  const knownIds = new Set((cachedList ?? []).map((info) => info.deviceId));
  // A presence roster naming a device the cached account list has never
  // seen (a peer enrolled elsewhere) forces a refetch, or that device
  // would stay invisible until a restart (M3).
  const hasUnknownOnline = [...online].some(
    (id) => id !== localDeviceId && !knownIds.has(id),
  );
  const shouldRefetch =
    cachedList === null ||
    (phase === "connected" && lastSocketPhase !== "connected") ||
    hasUnknownOnline;
  lastSocketPhase = phase;
  if (shouldRefetch) {
    try {
      cachedList = await window.api.account.listDevices();
    } catch {
      // Offline or signed out mid-flight. Keep whatever we had, an
      // empty list when nothing was ever fetched.
      cachedList = cachedList ?? [];
    }
  }
  // This machine is not a remote device to itself, so it is skipped.
  const others = (cachedList ?? []).filter(
    (info) => info.deviceId !== localDeviceId,
  );
  const devices = others.map((info) => buildEntry(info, current, online));
  noteConvergence(devices);
  setRemoteDevices(devices);
}

// Converge the views that fired while the keeper was still dialing.
// A device in phase "online" already carries an api (see buildEntry),
// so its queries run and hard-reject with "no direct connection". The
// keeper landing seconds later is invisible to react-query, whose own
// failure budget is long spent. The status snapshot IS the signal, and
// this module is its single reader, so the refetch belongs here and
// NOWHERE else: a per-call-site retry would be a second retry driver
// racing the keeper's ladder, which is exactly what supervision
// replaced. Scoped to the device that just landed, through
// invalidateDeviceSession and NOT the externalChange sweep: a session
// coming up is not a "that host's state moved" ping, and the sweep's
// exemptions (runtime, githubCli, fs, portForwards, updater, the two
// worktree cost domains) name exactly the queries that hard-failed
// during the dial window, so sweeping through them would refetch
// everything except what is broken.
function noteConvergence(devices: readonly RemoteDevice[]): void {
  const seen = new Set<string>();
  for (const device of devices) {
    const phase = device.status.phase;
    seen.add(device.deviceId);
    const previous = lastPhases.get(device.deviceId);
    lastPhases.set(device.deviceId, phase);
    if (previous !== "online" || phase !== "connected") continue;
    if (boundQueryClient !== null) {
      invalidateDeviceSession(boundQueryClient, device.deviceId);
    }
  }
  // Forget devices that left the list (revoked, or the account
  // changed), so a re-enroll starts from no remembered phase.
  for (const deviceId of lastPhases.keys()) {
    if (!seen.has(deviceId)) lastPhases.delete(deviceId);
  }
}

// Pure and synchronous: the peer's appVersion now rides the status
// snapshot (current.peerAppVersions), so an entry no longer fires a
// peerInfo IPC per device (M3). One lookup answers both questions: a
// peerAppVersions key IS the established-direct-session fact, and its
// value is the session's welcome-confirmed version.
function buildEntry(
  info: DeviceInfo,
  current: RelayStatus,
  online: ReadonlySet<string>,
): RemoteDevice {
  const socketConnected = current.socket.phase === "connected";
  const peerOnline = socketConnected && online.has(info.deviceId);
  const version = current.peerAppVersions[info.deviceId];
  let status: RemoteDeviceStatus;
  let appVersion = "";
  let api: RemoteDeviceApi | undefined;
  if (!socketConnected) {
    status = current.socket;
  } else if (!peerOnline) {
    status = { phase: "stopped" };
  } else if (version === undefined) {
    // In the roster but no direct session yet: main's keeper is
    // dialing or backing off toward one. The api is present anyway so
    // a view can stand ready and the invoke that races the landing
    // dial joins it -- and when the dial lands a beat later,
    // noteConvergence refetches whatever failed in the meantime.
    status = { phase: "online" };
    api = apiFor(info.deviceId);
  } else {
    appVersion = version;
    status = {
      phase: "connected",
      remoteDeviceId: info.deviceId,
      remoteAppVersion: appVersion,
    };
    api = apiFor(info.deviceId);
  }
  return {
    deviceId: info.deviceId,
    label: info.name,
    status,
    appVersion,
    api,
  };
}

function reconcile(status?: RelayStatus): void {
  queuedStatus = status;
  if (inFlight) {
    dirty = true;
    return;
  }
  void drainReconciles();
}

async function drainReconciles(): Promise<void> {
  inFlight = true;
  try {
    do {
      dirty = false;
      const status = queuedStatus;
      // oxlint-disable-next-line no-await-in-loop -- reconciles are serial by design
      await reconcileNow(status).catch(() => undefined);
    } while (dirty);
  } finally {
    inFlight = false;
  }
}

// Boot wiring: reconcile once now, then follow account and relay
// changes for the life of the window. Never unsubscribed on purpose,
// exactly like the other boot-scope subscriptions in index.tsx. This
// subscription is also the ONE writer of the useRelayStatus store:
// every snapshot it sees is published there, so no hook needs a
// subscription or an initial fetch of its own. The boot's query client
// comes in rather than being reached for, because both boots
// (renderer/index.tsx, web/app/boot.tsx) build their own.
export function startRemoteDeviceSync(queryClient: QueryClient): void {
  boundQueryClient = queryClient;
  window.api.account.onChanged(() => {
    cachedList = null;
    reconcile();
  });
  window.api.relay.onStatusChanged((status) => {
    publishRelayStatus(status);
    reconcile(status);
  });
  reconcile();
}
