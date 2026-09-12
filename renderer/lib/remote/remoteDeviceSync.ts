// Producer for the remote device registry.
// Rebuilds the store from the account's device registry plus the hub
// bridge's live status, on boot, on every hub statusChanged broadcast,
// and whenever the shared device-list query moves in the cache (which
// is where account changes, this window's own and everyone else's,
// land). There is no per-device
// supervisor here: the one hub socket lives in main, so a hub
// device's status DERIVES from the bridge instead of being driven.
//
// Status mapping, chosen to lie the least given the
// RemoteDeviceStatus vocabulary:
//   - a direct session established (a peerAppVersions key): phase
//     "connected" with the appVersion the session's welcome confirmed,
//     WHATEVER the hub socket is doing. Data is direct or nothing (v2
//     step 10, slice C), so an established direct session is the only
//     thing "connected" may mean, and it is also sufficient: the
//     device hub is orchestration only, and a live session survives
//     our own hub outage by design (shared/hub/directPresence.ts), so
//     a hub blip must not grey out a peer whose data wire is fine.
//   - no session and the hub socket not connected: mirror the socket's
//     supervisor phase (connecting, backoff, blocked and so on),
//     because nothing can be dialed while the socket is down and the
//     socket's state is the honest reason.
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
import { hashKey, type QueryClient } from "@tanstack/react-query";
import { buildApi } from "@shared/ipc/client";
import type { HubStatus } from "@shared/ipc/modules/hub";
import type { DeviceInfo } from "@shared/hub/protocol";
import { accountDevicesQueryOptions } from "@/hooks/account/useAccount";
import { publishHubStatus, seedHubStatus } from "@/hooks/remote/useHubStatus";
import { invalidateDeviceSession } from "@/lib/queryKeys";
import {
  rejectingClientTransport,
  type RemoteDevice,
  type RemoteDeviceApi,
  type RemoteDeviceStatus,
  setRemoteDevices,
} from "./devices";
import { createHubClientTransport } from "./hubTransport";

// The account device list lives in the shared react-query entry
// (accountDevicesQueryOptions, whose comment says why there is one
// copy). Reads here go through fetchQuery with staleTime Infinity, so
// a reconcile reuses whatever the cache holds rather than hitting the
// hub's HTTP endpoint on every presence and backoff transition. The
// three facts that make the list wrong ask for a refetch instead: an
// account change, a socket reconnect (which may follow an enroll or a
// revoke that happened while the socket was down), and a roster naming
// a device the list has never seen. A refetch's landing is what
// reconciles (the cache subscription in startRemoteDeviceSync), so a
// list change drives exactly one rebuild, and a refetch that fails
// leaves the store as it was.

// The last phase the hub socket reported, kept so a transition INTO
// connected can be spotted at all.
let lastSocketPhase = "";

// The queryHash of that one entry, so the cache subscription below can
// tell its events from every other query's in one comparison.
const deviceListHash = hashKey(accountDevicesQueryOptions.queryKey);

// One api per hub deviceId, built on first reachable sighting and
// kept: the transport forwards through the bridge, whose session for
// that peer is supervised desired state (main's keeper redials it
// forever), so the api never goes stale the way a dead socket does.
const apis = new Map<string, RemoteDeviceApi>();

// The query client of the boot that started the sync: the cache the
// device list is read from, and the target of the convergence
// invalidation below. Bound before the first reconcile and never
// cleared, so a null here is a boot-order bug, not a state.
let boundQueryClient: QueryClient | null = null;

function boundClient(): QueryClient {
  if (boundQueryClient === null) {
    throw new Error("remote device sync used before startRemoteDeviceSync");
  }
  return boundQueryClient;
}

// The devices whose direct session was live in the last snapshot seen,
// so every snapshot can spot a session LANDING (a key newly present)
// and sweep that device's cache. Diffed on every snapshot at the
// subscription itself, never inside the coalesced reconcile: a session
// that dropped and redialed inside one reconcile drain would otherwise
// read as "connected before, connected after" and its landing would
// go unswept.
let liveSessions: ReadonlySet<string> = new Set();

// Coalesce reconciles to latest-wins: presence events can arrive faster
// than a reconcile drains, and an unbounded promise chain would grow one
// pending link per event. A single in-flight run plus a dirty latch
// reruns once with the newest status when work piles up (M3).
let inFlight = false;
let dirty = false;
let queuedStatus: HubStatus | undefined;

// Exported for the per-device stores that outlive any one page (the
// script run stores), which need a device's api without a scope.
export function apiFor(deviceId: string): RemoteDeviceApi {
  const existing = apis.get(deviceId);
  if (existing !== undefined) return existing;
  const api = buildApi({
    host: createHubClientTransport(deviceId),
    client: rejectingClientTransport,
  });
  apis.set(deviceId, api);
  return api;
}

// Re-reads the shared list whether or not an observer is mounted (an
// invalidation alone would refetch only under the devices page). The
// landing reconciles through the cache subscription. A failure is
// swallowed there and the store keeps the last good list.
function refetchDeviceList(): void {
  void boundClient().refetchQueries({
    queryKey: accountDevicesQueryOptions.queryKey,
  });
}

// The list as the shared cache holds it, refetching only when it is
// missing or invalidated (staleTime Infinity says so, and fetchQuery
// honours an invalidation regardless of it).
function fetchDeviceList(): Promise<DeviceInfo[]> {
  return boundClient().fetchQuery({
    ...accountDevicesQueryOptions,
    staleTime: Infinity,
  });
}

async function reconcileNow(status?: HubStatus): Promise<void> {
  const current = status ?? (await window.api.hub.status());
  // A fetched snapshot seeds the shared store (a broadcast that raced
  // it is newer and wins), so this module stays the store's single
  // writer and the hooks never race a fetch of their own.
  // A fetched snapshot that lost the race to a broadcast is stale, and
  // must not roll the session diff back either.
  if (status === undefined && seedHubStatus(current)) noteSessions(current);
  const phase = current.socket.phase;
  const localDeviceId = window.api.deviceId;
  const online = new Set(current.onlineDeviceIds);
  const reconnected = phase === "connected" && lastSocketPhase !== "connected";
  lastSocketPhase = phase;
  // A reconnect can follow an enroll or a revoke that happened while
  // the socket was down. This pass runs on the list as it stands, and
  // the refetch's landing runs the corrected one.
  if (reconnected) refetchDeviceList();
  let list: DeviceInfo[];
  try {
    list = await fetchDeviceList();
  } catch {
    // Offline or signed out mid-flight. react-query keeps the last
    // good data through a failed refetch, so the store keeps whatever
    // we had, an empty list when nothing was ever fetched.
    list =
      boundClient().getQueryData(accountDevicesQueryOptions.queryKey) ?? [];
  }
  const knownIds = new Set(list.map((info) => info.deviceId));
  // A presence roster naming a device the account list has never seen
  // (a peer enrolled elsewhere) forces a refetch, or that device would
  // stay invisible until a restart (M3). Only a hub-driven pass asks
  // (status came in), never the pass a refetch's own landing queues:
  // a roster ghost the list will never explain would otherwise refetch
  // forever, while this way it re-asks once per hub event, as before.
  const hasUnknownOnline = [...online].some(
    (id) => id !== localDeviceId && !knownIds.has(id),
  );
  if (hasUnknownOnline && status !== undefined) refetchDeviceList();
  // This machine is not a remote device to itself, so it is skipped.
  const others = list.filter((info) => info.deviceId !== localDeviceId);
  const devices = others.map((info) => buildEntry(info, current, online));
  setRemoteDevices(devices);
}

// Resync on every session LANDING. A device in phase "online" already
// carries an api (see buildEntry), so its queries run and hard-reject
// with "no direct connection". The keeper landing seconds later is
// invisible to react-query, whose own failure budget is long spent.
// And a session that dropped and came back (a sleep, a network change,
// a heartbeat death) missed every push the host sent meanwhile, so its
// cached view is stale in ways nothing else will ping. The status
// snapshot IS the signal, and this module is its single reader, so the
// refetch belongs here and NOWHERE else: a per-call-site retry would be
// a second retry driver racing the keeper's ladder, which is exactly
// what supervision replaced. Scoped to the device that just landed,
// through invalidateDeviceSession and NOT the externalChange sweep: a
// session coming up is not a "that host's state moved" ping, and the
// sweep's exemptions (runtime, githubCli, fs, portForwards, updater,
// the two worktree cost domains) name exactly the queries that
// hard-failed during the dial window, so sweeping through them would
// refetch everything except what is broken.
function noteSessions(status: HubStatus): void {
  const now = new Set(Object.keys(status.peerAppVersions));
  for (const deviceId of now) {
    if (liveSessions.has(deviceId)) continue;
    if (boundQueryClient !== null) {
      invalidateDeviceSession(boundQueryClient, deviceId);
    }
  }
  liveSessions = now;
}

// Pure and synchronous: the peer's appVersion now rides the status
// snapshot (current.peerAppVersions), so an entry no longer fires a
// peerInfo IPC per device (M3). One lookup answers both questions: a
// peerAppVersions key IS the established-direct-session fact, and its
// value is the session's welcome-confirmed version.
function buildEntry(
  info: DeviceInfo,
  current: HubStatus,
  online: ReadonlySet<string>,
): RemoteDevice {
  const version = current.peerAppVersions[info.deviceId];
  let status: RemoteDeviceStatus;
  let api: RemoteDeviceApi | undefined;
  if (version !== undefined) {
    // A live direct session is the whole data plane, and it outlives a
    // hub blip on purpose, so it reads connected first, before the
    // socket phase is even consulted.
    status = {
      phase: "connected",
      remoteDeviceId: info.deviceId,
      remoteAppVersion: version,
    };
    api = apiFor(info.deviceId);
  } else if (current.socket.phase !== "connected") {
    status = current.socket;
  } else if (!online.has(info.deviceId)) {
    status = { phase: "stopped" };
  } else {
    // In the roster but no direct session yet: main's keeper is
    // dialing or backing off toward one. The api is present anyway so
    // a view can stand ready and the invoke that races the landing
    // dial joins it -- and when the dial lands a beat later,
    // noteSessions refetches whatever failed in the meantime.
    status = { phase: "online" };
    api = apiFor(info.deviceId);
  }
  return {
    deviceId: info.deviceId,
    label: info.name,
    status,
    appVersion: version ?? "",
    api,
  };
}

function reconcile(status?: HubStatus): void {
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

// Boot wiring: reconcile once now, then follow the account, the
// shared device-list cache and the hub for the life of the window.
// None of the three subscriptions is ever unsubscribed, on purpose,
// exactly like the other boot-scope subscriptions in index.tsx. The
// hub subscription is also the ONE writer of the useHubStatus store:
// every snapshot it sees is published there, so no hook needs a
// subscription or an initial fetch of its own. The boot's query client
// comes in rather than being reached for, because both boots
// (renderer/boot.tsx, one for both shells) build their own.
export function startRemoteDeviceSync(queryClient: QueryClient): void {
  boundQueryClient = queryClient;
  // This process's own enroll, sign-out, rename or revoke.
  window.api.account.onChanged(refetchDeviceList);
  // Every list change reconciles from here, this module's own refetches
  // included, alongside everyone else's landing in the shared cache (a
  // window focus, the devices page mounting, an invalidation from
  // anywhere). Rebuilding off the cache is the only way a peer's rename
  // or its removal from the account reaches this store at all: the hub
  // pushes neither, so nothing on the wire will ever say so.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (event.query.queryHash !== deviceListHash) return;
    reconcile();
  });
  window.api.hub.onStatusChanged((status) => {
    publishHubStatus(status);
    // Session landings are diffed here, on EVERY snapshot in order,
    // ahead of the coalesced reconcile that may skip intermediate
    // snapshots (see liveSessions).
    noteSessions(status);
    reconcile(status);
  });
  reconcile();
}
