// Producer for the remote device registry.
// Rebuilds the list (remoteDevicesAtom) from the account's device
// registry plus the hub bridge's live status (hubStatusAtom), on boot,
// on every hub statusChanged push, and whenever the shared device-list
// query moves in the cache (which is where account changes, this
// window's own and everyone else's, land). There is no per-device
// supervisor here: the one hub socket lives with the bridge (in the
// host, or in the web shell's page), so a hub device's status derives
// from the bridge instead of being driven.
//
// Each peer's status is buildEntry's, one branch per case.
import { departed } from "@shigomori/contracts/schemas/config";
import { fetchAgain } from "@/lib/askAgain";
import { throughCancel } from "@/lib/queryClientOptions";
import { hashKey, type QueryClient } from "@tanstack/react-query";
import { callOf } from "@shigomori/contracts/contract";
import { accountContract } from "@shigomori/contracts/modules/account";
import { hubContract, type HubStatus } from "@shigomori/contracts/modules/hub";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { accountDevicesQueryOptions } from "@/hooks/account/useAccount";
import { clientAtoms, clientPushes, heard } from "@/lib/runtime/atoms";
import type { RendererApi } from "@/lib/runtime/pageApi";
import { directPresenceRule } from "@shared/hub/directPresence";
import {
  hostKeyDeviceId,
  invalidateDeviceSession,
  queryKeys,
  removeDeviceCache,
} from "@/lib/queryKeys";
import {
  type RemoteDevice,
  type RemoteDeviceApi,
  remoteDevicesAtom,
  setRemoteDevices,
} from "./devices";
import type { RemoteDeviceStatus } from "@shigomori/ui/lib/deviceStatus.ts";

// The device list is the shared query entry, read with staleTime
// Infinity so a reconcile reuses the cache. An account change, a socket
// reconnect, and a roster naming an unknown device or dropping one ask
// for a refetch; its landing reconciles (the cache subscription), and a
// failed one leaves the store as it was.

// The last phase the hub socket reported, kept so a transition into
// connected can be spotted at all.
let lastSocketPhase = "";

// The last roster seen, so a device leaving it can be spotted: the
// hub pushes no removal, and a peer that signed out or was revoked
// looks exactly like one that went to sleep until the list is asked.
let lastRoster: ReadonlySet<string> = new Set();

// The queryHash of that one entry, so the cache subscription below can
// tell its events from every other query's in one comparison.
const deviceListHash = hashKey(queryKeys.accountDevices());

// One api per hub deviceId, built on first reachable sighting and
// kept: the transport forwards through the bridge, whose session for
// that peer the direct plane's keeper redials, so the api never goes
// stale the way a dead socket does.
// Its pushes reach the cache from the same moment (watchPeer), until
// the account is left (`unwatch`).
const apis = new Map<string, { api: RemoteDeviceApi; unwatch: () => void }>();

// The boot's per-device push wiring (lib/hostWatch.ts), handed in by
// startRemoteDeviceSync rather than imported, so this module stays
// below the hooks that wiring writes through.
type WatchPeer = (deviceId: string, api: RemoteDeviceApi) => () => void;
let watchPeer: WatchPeer | null = null;

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

// The page's api the boot started the sync with: the hub and account
// it follows, and the hop each peer's api rides. Bound with the query
// client, as is the page's registry, which the list is written to.
let boundPageApi: RendererApi | null = null;
let boundRegistry: AtomRegistry.AtomRegistry | null = null;

function registry(): AtomRegistry.AtomRegistry {
  if (boundRegistry === null) {
    throw new Error("remote device sync used before startRemoteDeviceSync");
  }
  return boundRegistry;
}

function pageApi(): RendererApi {
  if (boundPageApi === null) {
    throw new Error("remote device sync used before startRemoteDeviceSync");
  }
  return boundPageApi;
}

// The devices whose direct session was live in the last snapshot seen,
// so every snapshot can spot a session landing (a key newly present)
// and sweep that device's cache. Diffed on every snapshot at the
// subscription itself, never inside the coalesced reconcile: a session
// that dropped and redialed inside one reconcile drain would otherwise
// read as "connected before, connected after" and its landing would
// go unswept.
let liveSessions: ReadonlySet<string> = new Set();

// Each session's sharing switch in the last snapshot seen, so the one
// that just went off is dropped from the cache once (noteSessions).
let lastSharing: Readonly<Record<string, boolean>> = {};
// The newest status snapshot this page has heard or fetched, whose
// command access every pass leaves the list with: a pass built from an
// older one (out while a newer came) must not hand a peer back the
// access it has since taken away.
let newestStatus: HubStatus | undefined;

// Coalesce reconciles to latest-wins: presence events can arrive faster
// than a reconcile drains, and an unbounded promise chain would grow one
// pending link per event. A single in-flight run plus a dirty latch
// reruns once with the newest status when work piles up.
let inFlight = false;
let dirty = false;
let queued: Pass = { hubDriven: false };

// A pass of the reconcile: the snapshot a push brought (hubDriven) or
// the seed fetched as the page boots, or none, for a pass the list's
// landing queues, which asks the hub for one.
type Pass = { readonly status?: HubStatus; readonly hubDriven: boolean };

// Exported for the boot's followers of a peer (the shared settings
// exchange, the sweep requests), which need a device's api without a
// scope.
export function apiFor(deviceId: string): RemoteDeviceApi {
  const existing = apis.get(deviceId);
  if (existing !== undefined) return existing.api;
  if (watchPeer === null) {
    throw new Error("remote device sync used before startRemoteDeviceSync");
  }
  const api = pageApi().peerApi(deviceId);
  apis.set(deviceId, { api, unwatch: watchPeer(deviceId, api) });
  return api;
}

// Re-reads the shared list whether or not an observer is mounted (an
// invalidation alone would refetch only under the account page), one
// read at a time (fetchAgain). The landing reconciles through the cache
// subscription. A failure is swallowed there and the store keeps the
// last good list.
function askListAgain(): void {
  // The query itself, not refetchQueries, which passes over a query no
  // page reads that has never landed, a read of it out or not.
  const query = boundClient()
    .getQueryCache()
    .find({ queryKey: queryKeys.accountDevices(), exact: true });
  if (query !== undefined) fetchAgain(boundClient(), query, false);
}

// The list as the shared cache holds it, refetching only when it is
// missing or invalidated (staleTime Infinity says so, and fetchQuery
// honours an invalidation regardless of it).
function fetchDeviceList(): Promise<readonly DeviceInfo[]> {
  return throughCancel(() =>
    boundClient().fetchQuery({
      ...accountDevicesQueryOptions(pageApi()),
      staleTime: Infinity,
    }),
  );
}

async function reconcileNow({ status, hubDriven }: Pass): Promise<void> {
  const current = status ?? (await pageApi().run(pageApi().hub.status()));
  // A fetched snapshot seeds the status while none has landed, as the
  // boot's own fetch does: one that failed has these to fall back on.
  if (status === undefined) {
    seedFetched?.(current);
    // Taken as the newest unchecked. The host builds its snapshots and
    // sends its pushes in order from one process, so a fetched snapshot
    // is at least as new as any push heard before it.
    newestStatus = current;
  }
  const phase = current.socket.phase;
  const localDeviceId = pageApi().deviceId;
  const online = new Set(current.onlineDeviceIds);
  const reconnected = phase === "connected" && lastSocketPhase !== "connected";
  lastSocketPhase = phase;
  // No account (the socket stopped by the sign-out, or blocked as
  // revoked), no peers: the store empties by the direct plane's own
  // rule rather than by trusting the device-list refetch to come back
  // empty, since a refetch that fails falls back to the cached list
  // below, which would put the old account's device tabs back.
  if (directPresenceRule(current.socket) === "gone") {
    setRemoteDevices(registry(), []);
    lastRoster = new Set();
    return;
  }
  // A reconnect can follow an enroll or a revoke that happened while
  // the socket was down. This pass runs on the list as it stands, and
  // the refetch's landing runs the corrected one.
  if (reconnected) askListAgain();
  // This machine is not a remote device to itself, so it is skipped.
  const entries = (infos: readonly DeviceInfo[]) =>
    infos
      .filter((info) => info.deviceId !== localDeviceId)
      .map((info) => buildEntry(info, current, online));
  const cached = boundClient().getQueryData<readonly DeviceInfo[]>(
    queryKeys.accountDevices(),
  );
  // What the shell last had from the hub, for the account it holds
  // now. Its sessions outlive the window, so a live one reads connected.
  const kept = () =>
    pageApi()
      .run(pageApi().account.lastListedDevices())
      .catch(() => []);
  // A window with nothing fetched (one loaded while the hub is away)
  // draws the shell's list while its own read is out, which the
  // client's retries keep out for seconds.
  if (cached === undefined) {
    setRemoteDevices(registry(), entries(await kept()));
    if (newestStatus !== undefined && newestStatus !== current) {
      applyCommandAccess(newestStatus);
    }
  }
  let list: readonly DeviceInfo[];
  try {
    list = await fetchDeviceList();
  } catch {
    // Offline or signed out mid-flight. react-query keeps the last
    // good data through a failed refetch, so the store keeps whatever
    // we had. The shell's list is asked again, since the account can
    // have changed during the read.
    list =
      boundClient().getQueryData<readonly DeviceInfo[]>(
        queryKeys.accountDevices(),
      ) ?? (await kept());
  }
  const knownIds = new Set(list.map((info) => info.deviceId));
  // A roster naming a device the list hasn't seen, or a device leaving
  // the roster, asks for the list again: the hub pushes neither an
  // enrollment nor a removal, and the host's teardown of a mirror with a
  // departed device hangs off the list landing. Only a hub-driven pass
  // asks, so a roster ghost re-asks once per hub event, not forever.
  let someoneLeft = false;
  if (phase === "connected") {
    for (const id of lastRoster) if (!online.has(id)) someoneLeft = true;
    lastRoster = online;
  }
  const hasUnknownOnline = [...online].some(
    (id) => id !== localDeviceId && !knownIds.has(id),
  );
  if ((hasUnknownOnline || someoneLeft) && hubDriven) askListAgain();
  setRemoteDevices(registry(), entries(list));
  if (newestStatus !== undefined && newestStatus !== current) {
    applyCommandAccess(newestStatus);
  }
}

// Refetches a device's queries when its session lands: they rejected
// while the keeper dialed, past react-query's retries, and a session
// that dropped missed every push meanwhile. The snapshot is the one
// signal, so this is the one retry driver. Scoped with
// invalidateDeviceSession, not the externalChange sweep, whose exempt
// domains failed too.
//
// A peer that stops sharing is dropped from the cache, and lands like a
// new session when it shares again.
function noteSessions(status: HubStatus): void {
  const now = new Set(
    Object.keys(status.peerAppVersions).filter(
      (deviceId) => status.peerSharesData[deviceId] !== false,
    ),
  );
  for (const [deviceId, shares] of Object.entries(status.peerSharesData)) {
    if (!shares && lastSharing[deviceId] !== false && boundQueryClient) {
      removeDeviceCache(boundQueryClient, deviceId);
    }
  }
  for (const deviceId of now) {
    if (liveSessions.has(deviceId)) continue;
    if (boundQueryClient !== null) {
      invalidateDeviceSession(boundQueryClient, deviceId);
    }
    for (const listener of sessionLandedListeners) listener(deviceId);
  }
  liveSessions = now;
  lastSharing = status.peerSharesData;
}

// Followers of a session landing that have more to do than refetch:
// the shared settings exchange catches a peer up on what it missed
// while it was away. Boot-scoped like everything here, so there is no
// unsubscribe. A listener hears the sessions already up as landings
// too, so nothing rests on the order the boot starts things in.
const sessionLandedListeners = new Set<(deviceId: string) => void>();

export function onSessionLanded(listener: (deviceId: string) => void): void {
  sessionLandedListeners.add(listener);
  for (const deviceId of liveSessions) listener(deviceId);
}

// Followers with per-device state of their own to drop when the
// account is left (the boot's count of it, which the atoms that keep a
// peer's state read). Boot-scoped like the session-landed listeners.
const accountLeftListeners = new Set<() => void>();

export function onAccountLeft(listener: () => void): void {
  accountLeftListeners.add(listener);
}

// Everything this window built under the account that is now gone:
// the device store, the cached device list, every peer's api and every
// cache keyed by a peer's id. The local host's caches stay, they are
// this machine's whatever the account.
function leaveAccount(queryClient: QueryClient): void {
  setRemoteDevices(registry(), []);
  for (const { unwatch } of apis.values()) unwatch();
  apis.clear();
  liveSessions = new Set();
  lastSharing = {};
  queryClient.removeQueries({
    queryKey: queryKeys.accountDevices(),
    exact: true,
  });
  queryClient.removeQueries({
    predicate: (query) => {
      const deviceId = hostKeyDeviceId(query.queryKey);
      return deviceId !== undefined && deviceId !== pageApi().deviceId;
    },
  });
  for (const listener of accountLeftListeners) listener();
}

// Pure and synchronous: the peer's appVersion and command access ride
// the status snapshot (current.peerAppVersions, peerAcceptsCommands),
// so an entry asks the peer nothing. A peerAppVersions key is the
// established-direct-session fact, and its value is the session's
// welcome-confirmed version.
function buildEntry(
  info: DeviceInfo,
  current: HubStatus,
  online: ReadonlySet<string>,
): RemoteDevice {
  const version = current.peerAppVersions[info.deviceId];
  let status: RemoteDeviceStatus;
  let api: RemoteDeviceApi | undefined;
  if (
    version !== undefined &&
    current.peerSharesData[info.deviceId] === false
  ) {
    // Connected, but it serves nothing: no api, so nothing asks it.
    status = { phase: "notSharing" };
  } else if (version !== undefined) {
    // A live direct session is the whole data plane, and it outlives a
    // hub blip on purpose, so it reads connected first, before the
    // socket phase is even consulted.
    status = { phase: "connected" };
    api = apiFor(info.deviceId);
  } else if (current.socket.phase === "blocked") {
    // A blocked socket is a verdict on this device, not on the peers,
    // which are as unknown as when the app is offline: off, the
    // least-lying reading for every surface at once.
    status = { phase: "stopped" };
  } else if (current.socket.phase !== "connected") {
    status = current.socket;
  } else if (!online.has(info.deviceId)) {
    status = { phase: "stopped" };
  } else {
    // In the roster but no direct session yet: the direct plane's
    // keeper is dialing or backing off toward one. The api is present
    // anyway so a view can stand ready and the invoke that races the
    // landing dial joins it -- and when the dial lands a beat later,
    // noteSessions refetches whatever failed in the meantime.
    status = { phase: "online" };
    api = apiFor(info.deviceId);
  }
  return {
    deviceId: info.deviceId,
    label: info.name,
    platform: info.platform,
    icon: info.icon,
    status,
    appVersion: version ?? "",
    // One that isn't sharing runs nothing for this device either.
    acceptsCommands:
      status.phase === "notSharing"
        ? false
        : current.peerAcceptsCommands[info.deviceId],
    api,
  };
}

// The listed peers' command access from a snapshot as it comes, ahead
// of the pass it queues, which waits on the device list's fetch and on
// a pass already out: a peer that stopped taking commands from here is
// refused as it says so. Read as buildEntry reads it.
function applyCommandAccess(current: HubStatus): void {
  const listed = registry().get(remoteDevicesAtom);
  if (listed.length === 0) return;
  setRemoteDevices(
    registry(),
    listed.map((device) =>
      Object.assign({}, device, {
        // A peer the snapshot doesn't name keeps the access it had:
        // "not known" would read as pending, which commands, on an entry
        // whose api the pass hasn't retired yet.
        acceptsCommands:
          current.peerAppVersions[device.deviceId] !== undefined &&
          current.peerSharesData[device.deviceId] === false
            ? false
            : (current.peerAcceptsCommands[device.deviceId] ??
              device.acceptsCommands),
      }),
    ),
  );
}

function reconcile(pass: Pass): void {
  if (pass.status !== undefined) {
    newestStatus = pass.status;
    applyCommandAccess(pass.status);
  }
  queued = pass;
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
      const pass = queued;
      // oxlint-disable-next-line no-await-in-loop -- reconciles are serial by design
      await reconcileNow(pass).catch(() => undefined);
    } while (dirty);
  } finally {
    inFlight = false;
  }
}

// What a reconcile pass fetched, offered to the status while it has
// none (hubStatusAtom), for as long as the atom runs.
let seedFetched: ((status: HubStatus) => void) | null = null;

// The hub bridge's status: its pushes, seeded by a fetch at boot that
// any push beats. Each snapshot reaches noteSessions in order, ahead of
// the coalesced reconcile that may skip some.
export const hubStatusAtom = Atom.keepAlive(
  clientAtoms.atom(() => {
    let pushed = false;
    let seeded = false;
    const pushes = clientPushes(
      hubContract,
      callOf(hubContract, "statusChanged"),
    ).pipe(
      Stream.tap((status) =>
        heard("hub status", () => {
          pushed = true;
          noteSessions(status);
          reconcile({ status, hubDriven: true });
        }),
      ),
    );
    const boot = Stream.fromEffect(pageApi().hub.status()).pipe(
      Stream.catch(() => Stream.empty),
      Stream.filter(() => !pushed && !seeded),
      Stream.tap((status) =>
        heard("hub status", () => {
          seeded = true;
          noteSessions(status);
          reconcile({ status, hubDriven: false });
        }),
      ),
    );
    // A pass's fetch seeds it too, once, when the boot's failed.
    const fetched = Stream.callback<HubStatus>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          seedFetched = (status) => {
            if (pushed || seeded) return;
            seeded = true;
            noteSessions(status);
            Queue.offerUnsafe(queue, status);
          };
        }),
        () =>
          Effect.sync(() => {
            seedFetched = null;
          }),
      ),
    );
    return Stream.mergeAll([pushes, boot, fetched], {
      concurrency: "unbounded",
    });
  }),
);

// The hub's status as the sync last saw it, or null before the first.
export const hubStatusOf = (
  result: AsyncResult.AsyncResult<HubStatus, unknown>,
): HubStatus | null => (AsyncResult.isSuccess(result) ? result.value : null);

// Boot wiring, for the life of the window: the hub (hubStatusAtom,
// mounted here), the account and the shared device-list cache. The
// query client comes in rather than being reached for, since each boot
// builds its own.
export function startRemoteDeviceSync(
  api: RendererApi,
  queryClient: QueryClient,
  atoms: AtomRegistry.AtomRegistry,
  watch: WatchPeer,
  signal: AbortSignal,
): void {
  boundPageApi = api;
  boundQueryClient = queryClient;
  boundRegistry = atoms;
  watchPeer = watch;
  // This process's own enroll, sign-out, rename or revoke. A change of
  // account first drops everything built under the old one
  // (leaveAccount), so the new account's list lands on empty, not on
  // the old account's devices.
  // Unknown until the seed lands. A change to signed out is a
  // departure whatever came before, and the seed never overwrites a
  // change that beat it (null is a known value here).
  let syncedAccountId: string | null | undefined;
  api.listen(api.pushes(accountContract, "changed"), ({ accountId }) => {
    const leaving =
      syncedAccountId === undefined
        ? accountId === null
        : departed({ before: syncedAccountId, after: accountId });
    syncedAccountId = accountId;
    if (leaving) leaveAccount(queryClient);
    askListAgain();
  });
  void api.run(api.account.status()).then((status) => {
    if (syncedAccountId === undefined) {
      syncedAccountId = status.signedIn ? status.accountId : null;
    }
  });
  // Every list change reconciles from here, this module's own refetches
  // included. It's the only way a peer's rename or its removal reaches
  // this store: the hub pushes neither.
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (event.query.queryHash !== deviceListHash) return;
    reconcile({ hubDriven: false });
  });
  signal.addEventListener("abort", unsubscribe, { once: true });
  atoms.mount(hubStatusAtom);
}
