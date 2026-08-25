// Relay entries for the remote device registry (v2 step 4, slice C).
// Rebuilds the store's relay half from the account's device registry
// plus the relay bridge's live status, on boot, on account changes and
// on every relay statusChanged broadcast. There is no per-device
// supervisor here: the one relay socket lives in main, so a relay
// device's status DERIVES from the bridge instead of being driven.
//
// Status mapping, chosen to lie the least given deviceStatusView's
// fixed vocabulary:
//   - relay socket not connected: mirror the socket's supervisor phase
//     (connecting, backoff, blocked and so on), because no peer is
//     reachable while the socket is down and the socket's state is the
//     honest reason.
//   - socket connected and the peer in the presence roster: phase
//     "connected" with the deviceId and the appVersion the lazily
//     opened peer session confirmed ("" before that).
//   - socket connected but the peer absent from the roster: phase
//     "stopped", which renders as the neutral slate "Off" dot. "idle"
//     would render as "Connecting" (a lie, nothing is trying) and
//     "blocked" as a rose error (alarming for a machine that is simply
//     switched off), so the slate "Off" is the least-lying option.
import { buildApi } from "@shared/ipc/client";
import type { RelayStatus } from "@shared/ipc/modules/relay";
import type { DeviceInfo } from "@shared/relay/protocol";
import type { SupervisorStatus } from "@shared/remote/supervisor";
import {
  rejectingClientTransport,
  type RemoteDevice,
  type RemoteDeviceApi,
  setRelayDevices,
} from "./devices";
import { createRelayClientTransport } from "./relayTransport";

// The account device list, cached so presence and backoff transitions
// rebuild statuses without hitting the relay's HTTP endpoint every
// time. Refetched when unknown, on account changes, and when the
// socket transitions into connected (a reconnect may follow an enroll
// or revoke elsewhere).
let cachedList: DeviceInfo[] | null = null;
let lastSocketPhase = "";

// One api per relay deviceId, built on first connected sighting and
// kept: the transport forwards through the bridge, which redials
// lazily, so the api never goes stale the way a dead socket does.
const apis = new Map<string, RemoteDeviceApi>();

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
  setRelayDevices(devices);
}

// Pure and synchronous: the peer's appVersion now rides the status
// snapshot (current.peerAppVersions), so an entry no longer fires a
// peerInfo IPC per device (M3).
function buildEntry(
  info: DeviceInfo,
  current: RelayStatus,
  online: ReadonlySet<string>,
): RemoteDevice {
  const socketConnected = current.socket.phase === "connected";
  const peerOnline = socketConnected && online.has(info.deviceId);
  let status: SupervisorStatus;
  let appVersion = "";
  let api: RemoteDeviceApi | undefined;
  if (!socketConnected) {
    status = current.socket;
  } else if (!peerOnline) {
    status = { phase: "stopped" };
  } else {
    appVersion = current.peerAppVersions[info.deviceId] ?? "";
    status = {
      phase: "connected",
      remoteDeviceId: info.deviceId,
      remoteAppVersion: appVersion,
    };
    api = apiFor(info.deviceId);
  }
  return {
    kind: "relay",
    deviceId: info.deviceId,
    label: info.name,
    url: "",
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
// exactly like the other boot-scope subscriptions in index.tsx.
export function startRelayDeviceSync(): void {
  window.api.account.onChanged(() => {
    cachedList = null;
    reconcile();
  });
  window.api.relay.onStatusChanged((status) => reconcile(status));
  reconcile();
}
