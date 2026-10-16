// Producer for the remote device registry.
// Rebuilds the list (remoteDevicesAtom) from the account's device
// registry plus the hub bridge's live status (hubStatusAtom), on boot,
// on every hub statusChanged push, and whenever the shared device-list
// query moves in the cache (which is where account changes, this
// window's own and everyone else's, land). There is no per-device
// supervisor here: the one hub socket lives in the host, so a hub
// device's status DERIVES from the bridge instead of being driven.
//
// Status mapping, chosen to lie the least given the
// RemoteDeviceStatus vocabulary:
//   - the hub socket stopped: no devices at all. The socket is stopped
//     exactly while this device is signed out (the host's hub refresh),
//     and a signed-out window shows no peers, whatever the cached
//     device list still says.
//   - a direct session established (a peerAppVersions key): phase
//     "connected" with the appVersion the session's welcome confirmed
//     and the command access the peer reports (peerAcceptsCommands),
//     WHATEVER the hub socket is doing. Data is direct or nothing, so
//     an established direct session is the only
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
//     claims a data wire, and the host's keeper is already dialing or
//     backing off toward one (sessions are supervised desired state),
//     so the normal resolution is the next snapshot flipping the
//     device to "connected" with no action here.
//   - socket connected but the peer absent from the roster: phase
//     "stopped", which renders as the neutral slate "Off" dot. "idle"
//     would render as "Connecting" (a lie, nothing is trying) and
//     "blocked" as a rose error (alarming for a machine that is simply
//     switched off), so the slate "Off" is the least-lying option.
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
  queryKeysFor,
  removeDeviceCache,
} from "@/lib/queryKeys";
import {
  type RemoteDevice,
  type RemoteDeviceApi,
  remoteDevicesAtom,
  setRemoteDevices,
} from "./devices";
import type { RemoteDeviceStatus } from "@shigomori/ui/lib/deviceStatus.ts";

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

// The last roster seen, so a device LEAVING it can be spotted: the
// hub pushes no removal, and a peer that signed out or was revoked
// looks exactly like one that went to sleep until the list is asked.
let lastRoster: ReadonlySet<string> = new Set();

// The queryHash of that one entry, so the cache subscription below can
// tell its events from every other query's in one comparison.
const deviceListHash = hashKey(queryKeys.accountDevices());

// One api per hub deviceId, built on first reachable sighting and
// kept: the transport forwards through the bridge, whose session for
// that peer is supervised desired state (the host's keeper redials it
// forever), so the api never goes stale the way a dead socket does.
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
// so every snapshot can spot a session LANDING (a key newly present)
// and sweep that device's cache. Diffed on every snapshot at the
// subscription itself, never inside the coalesced reconcile: a session
// that dropped and redialed inside one reconcile drain would otherwise
// read as "connected before, connected after" and its landing would
// go unswept.
let liveSessions: ReadonlySet<string> = new Set();

// Each live session's command access in the last snapshot seen, so a
// peer's switch flipping mid-session can be spotted (noteSessions).
let lastAccess: Readonly<Record<string, boolean>> = {};

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
// invalidation alone would refetch only under the account page). The
// landing reconciles through the cache subscription. A failure is
// swallowed there and the store keeps the last good list. A read
// already out is joined, not cancelled: cancelling it sent the next,
// and its caller (throughCancel) asked again, so a burst of hub pushes
// was a burst of reads the hub answered with 429.
function refetchDeviceList(): void {
  void boundClient().refetchQueries(
    { queryKey: queryKeys.accountDevices() },
    { cancelRefetch: false },
  );
}

// The re-read a roster asks for (a device the list doesn't know, one
// that left): one at a time, and a roster that changes while one is out
// asks for one more after it settles, however many times it changed. A
// read already out may predate the change, so it is not trusted to
// answer it, and it is never cancelled.
let listRead: Promise<unknown> | null = null;
let readAgain = false;
function askListAgain(): void {
  if (listRead !== null) {
    readAgain = true;
    return;
  }
  listRead = boundClient()
    .refetchQueries(
      { queryKey: queryKeys.accountDevices() },
      { cancelRefetch: false },
    )
    .finally(() => {
      listRead = null;
      if (!readAgain) return;
      readAgain = false;
      askListAgain();
    });
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
  if (reconnected) refetchDeviceList();
  let list: readonly DeviceInfo[];
  try {
    list = await fetchDeviceList();
  } catch {
    // Offline or signed out mid-flight. react-query keeps the last
    // good data through a failed refetch, so the store keeps whatever
    // we had, an empty list when nothing was ever fetched.
    list =
      boundClient().getQueryData<readonly DeviceInfo[]>(
        queryKeys.accountDevices(),
      ) ?? [];
  }
  const knownIds = new Set(list.map((info) => info.deviceId));
  // A presence roster naming a device the account list has never seen
  // (a peer enrolled elsewhere) forces a refetch, or that device would
  // stay invisible until a restart. Only a hub-driven pass asks
  // (status came in), never the pass a refetch's own landing queues:
  // a roster ghost the list will never explain would otherwise refetch
  // forever, while this way it re-asks once per hub event, as before.
  // A device that left the roster may have left the account (a
  // sign-out, a revoke on another device), which only the list can
  // say, and which the host's own peer-side teardown (a mirror with that
  // device) hangs off the list landing. One HTTP call per departure,
  // like the unknown-online rule.
  let someoneLeft = false;
  if (phase === "connected") {
    for (const id of lastRoster) if (!online.has(id)) someoneLeft = true;
    lastRoster = online;
  }
  const hasUnknownOnline = [...online].some(
    (id) => id !== localDeviceId && !knownIds.has(id),
  );
  if ((hasUnknownOnline || someoneLeft) && hubDriven) askListAgain();
  // This machine is not a remote device to itself, so it is skipped.
  const others = list.filter((info) => info.deviceId !== localDeviceId);
  const devices = others.map((info) => buildEntry(info, current, online));
  setRemoteDevices(registry(), devices);
  if (newestStatus !== undefined && newestStatus !== current) {
    applyCommandAccess(newestStatus);
  }
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
//
// A peer's sharing switch is another thing only the snapshot says. A
// session whose peer isn't sharing is not a live one here: what the
// peer shared is dropped from the cache as the switch goes off, and
// it lands like a new session when the switch comes back on.
//
// A peer's command access flipping on a session that stays up is the
// last thing only the snapshot says. Runtime info is gated on it (a
// peer refuses it to a device it will not take commands from), caches
// forever and sits outside the state-moved sweep, so it is re-asked
// here or the peer's paths stay raw until a focus. Either direction
// re-asks: the read is silent, so an off flip costs one refused round
// trip and no toast. The full session sweep is deliberately not used:
// it would refetch every gated read, and on an off flip each of those
// would toast a refusal.
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
    if (liveSessions.has(deviceId)) {
      const before = lastAccess[deviceId];
      const after = status.peerAcceptsCommands[deviceId];
      if (before !== undefined && before !== after && boundQueryClient) {
        void boundQueryClient.invalidateQueries({
          queryKey: queryKeysFor(deviceId).runtimeInfo(),
        });
      }
      continue;
    }
    if (boundQueryClient !== null) {
      invalidateDeviceSession(boundQueryClient, deviceId);
    }
    for (const listener of sessionLandedListeners) listener(deviceId);
  }
  liveSessions = now;
  lastAccess = status.peerAcceptsCommands;
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
  lastAccess = {};
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
// so an entry asks the peer nothing. A peerAppVersions key IS the
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
    status = {
      phase: "connected",
      remoteDeviceId: info.deviceId,
      remoteAppVersion: version,
    };
    api = apiFor(info.deviceId);
  } else if (current.socket.phase === "blocked") {
    // A blocked socket is a verdict on THIS device, not on the peers,
    // which are as unknown as when the app is offline: off, the
    // least-lying reading for every surface at once.
    status = { phase: "stopped" };
  } else if (current.socket.phase !== "connected") {
    status = current.socket;
  } else if (!online.has(info.deviceId)) {
    status = { phase: "stopped" };
  } else {
    // In the roster but no direct session yet: the host's keeper is
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

// The hub bridge's live status: its statusChanged pushes, seeded by a
// fetch as the page boots (a push that raced the fetch is newer and
// wins, and the stale seed must not roll the session diff back
// either). Every snapshot reaches the sync here, in order, as it comes:
// session landings are diffed on each one, ahead of the coalesced
// reconcile that may skip intermediate snapshots (see liveSessions),
// and a reader may only see the latest. Mounted by the sync for the
// life of the page, so every reader (the tunnel marker on the devices
// section, the web devices page's own-row status, the account sync's
// sign-out trigger) reads the same value. Initial until the first
// snapshot lands.
// What a reconcile pass fetched, offered to the status while it has
// none (hubStatusAtom), for as long as the atom runs.
let seedFetched: ((status: HubStatus) => void) | null = null;

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

// Boot wiring: follow the hub (hubStatusAtom, mounted here), the
// account and the shared device-list cache for the life of the window.
// The account and cache subscriptions are never unsubscribed, on
// purpose, exactly like the other boot-scope subscriptions in boot.tsx;
// the hub's ends with the page's registry. The boot's query client
// comes in rather than being reached for, because both boots
// (renderer/boot.tsx, one for both shells) build their own, and so
// does the push wiring each peer's api gets.
export function startRemoteDeviceSync(
  api: RendererApi,
  queryClient: QueryClient,
  atoms: AtomRegistry.AtomRegistry,
  watch: WatchPeer,
): void {
  boundPageApi = api;
  boundQueryClient = queryClient;
  boundRegistry = atoms;
  watchPeer = watch;
  // This process's own enroll, sign-out, rename or revoke. A change of
  // ACCOUNT (a sign-out, a sign-in under another account) also drops
  // everything built under the old one, before the refetch, so what
  // the new account's list lands on is empty rather than the old
  // account's devices: the cached device list (which the reconcile
  // falls back to when a refetch fails), the per-device apis and
  // caches, and the followers' per-device state. A rename keeps it
  // all: same account, same peers.
  // Unknown until the seed lands. A change to signed out is a
  // departure whatever came before, and the seed never overwrites a
  // change that beat it (null is a known value here).
  let syncedAccountId: string | null | undefined;
  api.listen(api.pushes(accountContract, "changed"), ({ accountId }) => {
    const leaving =
      syncedAccountId === undefined
        ? accountId === null
        : syncedAccountId !== null && accountId !== syncedAccountId;
    syncedAccountId = accountId;
    if (leaving) leaveAccount(queryClient);
    refetchDeviceList();
  });
  void api.run(api.account.status()).then((status) => {
    if (syncedAccountId === undefined) {
      syncedAccountId = status.signedIn ? status.accountId : null;
    }
  });
  // Every list change reconciles from here, this module's own refetches
  // included, alongside everyone else's landing in the shared cache (a
  // window focus, the account page mounting, an invalidation from
  // anywhere). Rebuilding off the cache is the only way a peer's rename
  // or its removal from the account reaches this store at all: the hub
  // pushes neither, so nothing on the wire will ever say so.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (event.query.queryHash !== deviceListHash) return;
    reconcile({ hubDriven: false });
  });
  atoms.mount(hubStatusAtom);
}
