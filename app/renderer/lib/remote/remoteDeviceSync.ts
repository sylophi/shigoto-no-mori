// Producer for the remote device registry, one per page boot.
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
import { accountContract } from "@shigomori/contracts/modules/account";
import { hubContract, type HubStatus } from "@shigomori/contracts/modules/hub";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { outdatedModules } from "@shigomori/contracts/link";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { accountDevicesQueryOptions } from "@/hooks/account/useAccount";
import { heard } from "@/lib/runtime/atoms";
import type { RendererApi } from "@/lib/runtime/pageApi";
import { directPresenceRule } from "@shared/hub/directPresence";
import {
  hostKeyDeviceId,
  invalidateDeviceSession,
  queryKeys,
  removeDeviceCache,
} from "@/lib/queryKeys";
import type { HostApi } from "@/lib/runtime/Api";
import {
  type RemoteDevice,
  remoteDevicesAtom,
  setRemoteDevices,
} from "./devices";
import type { RemoteDeviceStatus } from "@shigomori/ui/lib/deviceStatus.ts";

// The hub bridge's newest status snapshot, null until the first lands.
export const hubStatusAtom = Atom.keepAlive(Atom.make<HubStatus | null>(null));

// The queryHash of the device list's entry, so the cache subscription
// below can tell its events from every other query's in one comparison.
const deviceListHash = hashKey(queryKeys.accountDevices());

// What follows a peer beyond its entry in the list: each session to it
// landing (a session already up when the sync starts lands too), and
// the account being left, which drops every peer.
export type PeerFollower = {
  readonly sessionLanded: (deviceId: string) => void;
  readonly accountLeft: () => void;
};

// A pass of the reconcile: the snapshot a push brought (hubDriven), or
// none, for a pass that asks the hub for one (the boot's, and one the
// list's landing queues).
type Pass = { readonly status?: HubStatus; readonly hubDriven: boolean };

// Whether a peer runs this device's commands, as `status` says. One that
// isn't sharing runs nothing for this device either. One the snapshot
// doesn't name keeps `had`: "not known" would read as pending, which
// commands, on an entry whose api the pass hasn't retired yet.
function accessOf(
  status: HubStatus,
  deviceId: string,
  had?: boolean,
): boolean | undefined {
  const connected = status.peerAppVersions[deviceId] !== undefined;
  if (connected && status.peerSharesData[deviceId] === false) return false;
  return status.peerAcceptsCommands[deviceId] ?? had;
}

// Boot wiring, for the life of the page (`signal`): the hub, the account
// and the shared device-list cache.
export function startRemoteDeviceSync({
  api,
  queryClient,
  registry,
  watchPeer,
  followers,
  signal,
}: {
  api: RendererApi;
  queryClient: QueryClient;
  registry: AtomRegistry.AtomRegistry;
  // The boot's per-device push wiring (lib/hostWatch.ts), handed in
  // rather than imported, so this module stays below the hooks that
  // wiring writes through.
  watchPeer: (deviceId: string, peer: HostApi) => () => void;
  followers: readonly PeerFollower[];
  signal: AbortSignal;
}): void {
  // The last phase the hub socket reported, kept so a transition into
  // connected can be spotted at all.
  let lastSocketPhase = "";

  // The last roster seen, so a device leaving it can be spotted: the
  // hub pushes no removal, and a peer that signed out or was revoked
  // looks exactly like one that went to sleep until the list is asked.
  let lastRoster: ReadonlySet<string> = new Set();

  // The devices whose direct session was live in the last snapshot
  // heard, so every snapshot can spot a session landing (a key newly
  // present) and sweep that device's cache. Diffed on every snapshot as
  // it is heard, never inside the coalesced reconcile: a session that
  // dropped and redialed inside one pass would otherwise read as
  // "connected before, connected after" and its landing would go
  // unswept.
  let liveSessions: ReadonlySet<string> = new Set();

  // Each session's sharing switch in the last snapshot heard, so the one
  // that just went off is dropped from the cache once (noteSessions).
  let lastSharing: Readonly<Record<string, boolean>> = {};

  // How many snapshots have been heard, so a read can tell whether one
  // landed while it was out.
  let heardCount = 0;

  // The peers whose pushes reach the cache (watchPeer), from their first
  // sighting until the account is left. The page's api keeps one api
  // per peer, which the transport forwards through the bridge, whose
  // session for that peer the direct plane's keeper redials, so it
  // never goes stale the way a dead socket does.
  const watched = new Map<string, () => void>();

  const followPeer = (deviceId: string): void => {
    if (!watched.has(deviceId)) {
      watched.set(deviceId, watchPeer(deviceId, api.peerApi(deviceId)));
    }
  };

  // The list written with each peer's command access as the newest
  // snapshot says. A pass waits on the device list's fetch and on a pass
  // already out, so a snapshot that comes meanwhile rewrites the access
  // as it lands: a peer that stopped taking commands from here is
  // refused as it says so.
  const applyNewestAccess = (devices: readonly RemoteDevice[]): void => {
    const newest = registry.get(hubStatusAtom);
    setRemoteDevices(
      registry,
      newest === null
        ? devices
        : devices.map((device) =>
            Object.assign({}, device, {
              acceptsCommands: accessOf(
                newest,
                device.deviceId,
                device.acceptsCommands,
              ),
            }),
          ),
    );
  };

  // Re-reads the shared list whether or not an observer is mounted (an
  // invalidation alone would refetch only under the account page), one
  // read at a time (fetchAgain). The landing reconciles through the
  // cache subscription. A failure is swallowed there and the store keeps
  // the last good list.
  const askListAgain = (): void => {
    // The query itself, not refetchQueries, which passes over a query no
    // page reads that has never landed, a read of it out or not.
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: queryKeys.accountDevices(), exact: true });
    if (query !== undefined) fetchAgain(queryClient, query, false);
  };

  const cachedList = () =>
    queryClient.getQueryData<readonly DeviceInfo[]>(queryKeys.accountDevices());

  // The list as the shared cache holds it, refetching only when it is
  // missing or invalidated (staleTime Infinity says so, and fetchQuery
  // honours an invalidation regardless of it).
  const fetchDeviceList = () =>
    throughCancel(() =>
      queryClient.fetchQuery({
        ...accountDevicesQueryOptions(api),
        staleTime: Infinity,
      }),
    );

  // Refetches a device's queries when its session lands: they rejected
  // while the keeper dialed, past react-query's retries, and a session
  // that dropped missed every push meanwhile. The snapshot is the one
  // signal, so this is the one retry driver. Scoped with
  // invalidateDeviceSession, not the externalChange sweep, whose exempt
  // domains failed too.
  //
  // A peer that stops sharing is dropped from the cache, and lands like a
  // new session when it shares again.
  const noteSessions = (status: HubStatus): void => {
    const now = new Set(
      Object.keys(status.peerAppVersions).filter(
        (deviceId) => status.peerSharesData[deviceId] !== false,
      ),
    );
    for (const [deviceId, shares] of Object.entries(status.peerSharesData)) {
      if (!shares && lastSharing[deviceId] !== false) {
        removeDeviceCache(queryClient, deviceId);
      }
    }
    for (const deviceId of now) {
      if (liveSessions.has(deviceId)) continue;
      invalidateDeviceSession(queryClient, deviceId);
      for (const follower of followers) follower.sessionLanded(deviceId);
      // Its pushes are followed from the landing on, ahead of the pass
      // that lists it.
      followPeer(deviceId);
    }
    liveSessions = now;
    lastSharing = status.peerSharesData;
  };

  // Every snapshot heard, in the order it is heard, ahead of the passes
  // that coalesce them.
  const hearStatus = (status: HubStatus): void => {
    heardCount += 1;
    noteSessions(status);
    registry.set(hubStatusAtom, status);
    applyNewestAccess(registry.get(remoteDevicesAtom));
  };

  // The hub's snapshot now, heard unless another was heard while it was
  // out, which is newer.
  const readStatus = Effect.suspend(() => {
    const before = heardCount;
    return Effect.tap(api.hub.status(), (status) =>
      heard("hub status", () => {
        if (heardCount === before) hearStatus(status);
      }),
    );
  });

  // Everything this window built under the account that is now gone:
  // the device store, the cached device list, every peer's watch and
  // every cache keyed by a peer's id. The local host's caches stay, they
  // are this machine's whatever the account.
  const leaveAccount = (): void => {
    setRemoteDevices(registry, []);
    for (const unwatch of watched.values()) unwatch();
    watched.clear();
    liveSessions = new Set();
    lastSharing = {};
    queryClient.removeQueries({
      queryKey: queryKeys.accountDevices(),
      exact: true,
    });
    queryClient.removeQueries({
      predicate: (query) => {
        const deviceId = hostKeyDeviceId(query.queryKey);
        return deviceId !== undefined && deviceId !== api.deviceId;
      },
    });
    for (const follower of followers) follower.accountLeft();
  };

  // Pure and synchronous: the peer's appVersion and command access ride
  // the status snapshot (current.peerAppVersions, peerAcceptsCommands),
  // so an entry asks the peer nothing. A peerAppVersions key is the
  // established-direct-session fact, and its value is the session's
  // welcome-confirmed version.
  const buildEntry = (
    info: DeviceInfo,
    current: HubStatus,
    online: ReadonlySet<string>,
  ): RemoteDevice => {
    const version = current.peerAppVersions[info.deviceId];
    const coreOutdated = current.peerCoreOutdated[info.deviceId];
    let status: RemoteDeviceStatus;
    if (
      version !== undefined &&
      current.peerSharesData[info.deviceId] === false
    ) {
      // Connected, but it serves nothing, so nothing asks it.
      status = { phase: "notSharing" };
    } else if (version !== undefined) {
      // A live direct session is the whole data plane, and it outlives a
      // hub blip on purpose, so it reads connected first, before the
      // socket phase is even consulted. With what of the peer this build
      // can't call, when the two run different releases.
      const outdated = outdatedModules(
        current.peerVersions[info.deviceId] ?? {},
      );
      status =
        outdated === undefined
          ? { phase: "connected" }
          : {
              phase: "connected",
              outdated: outdated.side,
              modules: outdated.modules,
            };
      followPeer(info.deviceId);
    } else if (current.socket.phase === "blocked") {
      // A blocked socket is a verdict on this device, not on the peers,
      // which are as unknown as when the app is offline: off, the
      // least-lying reading for every surface at once.
      status = { phase: "stopped" };
    } else if (current.socket.phase !== "connected") {
      status = current.socket;
    } else if (!online.has(info.deviceId)) {
      status = { phase: "stopped" };
    } else if (coreOutdated !== undefined) {
      // Rostered, and its listener refuses this build's hello: no
      // session lands until one of the two updates.
      status = { phase: "outdated", outdated: coreOutdated };
    } else {
      // In the roster but no direct session yet: the direct plane's
      // keeper is dialing or backing off toward one. A view can stand
      // ready anyway and the invoke that races the landing dial joins
      // it. When the dial lands a beat later, noteSessions refetches
      // whatever failed in the meantime.
      status = { phase: "online" };
      followPeer(info.deviceId);
    }
    return {
      deviceId: info.deviceId,
      label: info.name,
      platform: info.platform,
      icon: info.icon,
      status,
      appVersion: version ?? "",
      acceptsCommands: accessOf(current, info.deviceId),
    };
  };

  const reconcileNow = Effect.fnUntraced(function* ({
    status,
    hubDriven,
  }: Pass) {
    const current = status ?? (yield* readStatus);
    const phase = current.socket.phase;
    const localDeviceId = api.deviceId;
    const online = new Set(current.onlineDeviceIds);
    const reconnected =
      phase === "connected" && lastSocketPhase !== "connected";
    lastSocketPhase = phase;
    // No account (the socket stopped by the sign-out, or blocked as
    // revoked), no peers: the store empties by the direct plane's own
    // rule rather than by trusting the device-list refetch to come back
    // empty, since a refetch that fails falls back to the cached list
    // below, which would put the old account's device tabs back.
    if (directPresenceRule(current.socket) === "gone") {
      setRemoteDevices(registry, []);
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
    // What the shell last had from the hub, for the account it holds
    // now. Its sessions outlive the window, so a live one reads connected.
    const kept = api.account
      .lastListedDevices()
      .pipe(Effect.orElseSucceed((): readonly DeviceInfo[] => []));
    // A window with nothing fetched (one loaded while the hub is away)
    // draws the shell's list while its own read is out, which the
    // client's retries keep out for seconds.
    if (cachedList() === undefined) applyNewestAccess(entries(yield* kept));
    // Offline or signed out mid-flight, the read fails. react-query
    // keeps the last good data through a failed refetch, so the store
    // keeps whatever we had. The shell's list is asked again, since the
    // account can have changed during the read.
    const list = yield* Effect.tryPromise(fetchDeviceList).pipe(
      Effect.catch(() => {
        const cached = cachedList();
        return cached === undefined ? kept : Effect.succeed(cached);
      }),
    );
    const knownIds = new Set(list.map((info) => info.deviceId));
    // A roster naming a device the list hasn't seen, or a device leaving
    // the roster, asks for the list again: the hub pushes neither an
    // enrollment nor a removal, and the host's teardown of a mirror with
    // a departed device hangs off the list landing. Only a hub-driven
    // pass asks, so a roster ghost re-asks once per hub event, not
    // forever.
    let someoneLeft = false;
    if (phase === "connected") {
      for (const id of lastRoster) if (!online.has(id)) someoneLeft = true;
      lastRoster = online;
    }
    const hasUnknownOnline = [...online].some(
      (id) => id !== localDeviceId && !knownIds.has(id),
    );
    if ((hasUnknownOnline || someoneLeft) && hubDriven) askListAgain();
    applyNewestAccess(entries(list));
  });

  // Unknown until the account's status lands. A change to signed out is
  // a departure whatever came before, and the status never overwrites a
  // change that beat it (null is a known value here).
  let syncedAccountId: string | null | undefined;

  // This process's own enroll, sign-out, rename or revoke. A change of
  // account first drops everything built under the old one
  // (leaveAccount), so the new account's list lands on empty, not on the
  // old account's devices.
  const accountChanged = (accountId: string | null): void => {
    const leaving =
      syncedAccountId === undefined
        ? accountId === null
        : departed({ before: syncedAccountId, after: accountId });
    syncedAccountId = accountId;
    if (leaving) leaveAccount();
    askListAgain();
  };

  void api
    .run(
      Effect.gen(function* () {
        // One pass at a time, and of those asked for while one runs, the
        // last: presence events can arrive faster than a pass drains.
        const passes = yield* Queue.sliding<Pass>(1);
        const reconcile = (pass: Pass) => Queue.offerUnsafe(passes, pass);
        // Every list change reconciles from here, the sync's own
        // refetches included. It's the only way a peer's rename or its
        // removal reaches this store: the hub pushes neither.
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            queryClient.getQueryCache().subscribe((event) => {
              if (event.type !== "updated") return;
              if (event.action.type !== "success") return;
              if (event.query.queryHash !== deviceListHash) return;
              reconcile({ hubDriven: false });
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        // The boot's pass, whose read is the status's seed.
        reconcile({ hubDriven: false });
        const runPasses = Queue.take(passes).pipe(
          Effect.flatMap((pass) => Effect.exit(reconcileNow(pass))),
          Effect.forever,
        );
        const followHubStatus = Stream.runForEach(
          api.pushes(hubContract, "statusChanged"),
          (status) =>
            heard("hub status", () => {
              hearStatus(status);
              reconcile({ status, hubDriven: true });
            }),
        );
        const followAccount = Stream.runForEach(
          api.pushes(accountContract, "changed"),
          ({ accountId }) =>
            heard("account change", () => accountChanged(accountId)),
        );
        const seedAccountId = api.account.status().pipe(
          Effect.tap((status) =>
            Effect.sync(() => {
              if (syncedAccountId === undefined) {
                syncedAccountId = status.signedIn ? status.accountId : null;
              }
            }),
          ),
          Effect.ignore,
        );
        yield* Effect.all(
          [runPasses, followHubStatus, followAccount, seedAccountId],
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.scoped),
      { signal },
    )
    .catch(() => undefined);
}
