import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import type { UpdaterState } from "@shared/schemas";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { useHostDevices } from "@/hooks/remote/useRemoteDevices";
import { hasLocalHost } from "@/lib/localHost";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";

// One device's updater state, under that device's own key. Errors stay
// silent: an older peer build without the channel answers no-handler,
// and the Version section shows that as unavailable rather than
// toasting on every visit.
function updaterStateQueryOptions(deviceId: string, api: HostApi) {
  return queryOptions<UpdaterState>({
    queryKey: queryKeysFor(deviceId).updaterState(),
    queryFn: () => api.updater.get(),
    // Never stale: the updater:state broadcast is mirrored into this
    // key for the window's lifetime, this machine's by the boot-scope
    // subscription (boot.tsx) and a peer's by the push watch
    // (remoteHostWatch), and a peer's is re-read whenever its session
    // lands, which covers a restart into the new build.
    staleTime: Number.POSITIVE_INFINITY,
    // A focus has nothing to add to that, and an older peer build
    // (whose read never succeeds, so it is always stale) would
    // otherwise be re-asked, with retries, on every one.
    refetchOnWindowFocus: false,
    meta: { silentError: true },
  });
}

// The one writer both boot-scope mirrors go through. A push landing
// while the seeding read is still in flight would be overwritten by
// that read's older answer, for good under the staleTime above, so the
// read is dropped first: the push is the newer word.
export function writeUpdaterState(
  queryClient: QueryClient,
  deviceId: string,
  state: UpdaterState,
): void {
  const queryKey = queryKeysFor(deviceId).updaterState();
  void queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, state);
}

// Seeded from `updater:get` and then driven entirely by the
// `updater:state` broadcast, with no polling. The serving process is
// the single source of truth. The renderer just mirrors it, at boot
// scope rather than here (see the staleTime note above). Reads its
// device from the host scope: this window's own updater with no
// provider mounted, or a peer's over its direct session inside one,
// so the same Settings card answers for whichever device is selected.
export function useUpdater() {
  const { deviceId, api } = useHostScope();
  const query = useQuery(updaterStateQueryOptions(deviceId, api));

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast is the single source of truth, and the boot-scope mirrors write each new state into the cache
  const check = useMutation({
    mutationFn: () => api.updater.check(),
    meta: { errorTitle: "Couldn't check for updates" },
  });
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast is the single source of truth, and the boot-scope mirrors write each new state into the cache
  const install = useMutation({
    mutationFn: () => api.updater.install(),
    meta: { errorTitle: "Couldn't install the update" },
  });

  // The explicit annotation strips react-query's NoInfer wrapper from
  // `data`; tsgo (TypeScript 7) can't narrow the discriminated union
  // through the intrinsic NoInfer that query-core 5.101 switched to.
  const state: UpdaterState | null = query.data ?? null;
  return {
    state,
    check,
    install,
    isError: query.isError,
    refetch: query.refetch,
  };
}

// The updates this window could install right now, as deviceId to the
// staged version, this machine's first: its own, plus every peer's
// that is reachable and lets this device command it (a staged update
// behind a refused grant has no button to lead to). What the sidebar's
// Settings dot and the Settings device rows flag. A peer is asked only
// once its grant verdict has landed, not on the optimistic in-flight
// reading the forms use: a dot that lights and then goes out is worse
// than one that lights a moment later. A plain object so react-query
// can hand back the same reference while the answer is unchanged.
export function useStagedUpdates(): Readonly<Record<string, string>> {
  // Reach first, so a peer with no session is never preflighted.
  const peers = useHostDevices().filter(
    (peer) => deviceStatusView(peer.status).reachable,
  );
  const access = usePeerCommandAccess(peers);
  const targets = [
    ...(hasLocalHost ? [{ deviceId: localDeviceId, api: window.api }] : []),
    ...peers.flatMap((peer) =>
      peer.api !== undefined && commandAccessOf(access, peer.deviceId).granted
        ? [{ deviceId: peer.deviceId, api: peer.api }]
        : [],
    ),
  ];
  return useQueries({
    queries: targets.map((target) =>
      updaterStateQueryOptions(target.deviceId, target.api),
    ),
    combine: (results) => {
      const staged: Record<string, string> = {};
      targets.forEach((target, index) => {
        const state: UpdaterState | undefined = results[index]?.data;
        if (state?.kind === "ready") staged[target.deviceId] = state.version;
      });
      return staged;
    },
  });
}
