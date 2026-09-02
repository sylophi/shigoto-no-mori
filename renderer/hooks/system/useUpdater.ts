import { useEffect } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { UpdaterState } from "@shared/schemas";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { queryKeysFor } from "@/lib/queryKeys";

// One device's updater state, under that device's own key. Errors stay
// silent: an older peer build without the channel answers no-handler,
// and the Version section shows that as unavailable rather than
// toasting on every visit.
function updaterStateQueryOptions(
  deviceId: string,
  api: HostApi,
  remote: boolean,
) {
  return queryOptions<UpdaterState>({
    queryKey: queryKeysFor(deviceId).updaterState(),
    queryFn: () => api.updater.get(),
    // This window's state is kept live for the app's lifetime by the
    // sidebar's always-mounted subscription. A peer's is subscribed
    // only while its section is mounted, so a remount re-reads it
    // rather than trust a cached "ready" the peer may have installed
    // meanwhile (same cadence as the command-access preflight).
    staleTime: remote ? 30_000 : Number.POSITIVE_INFINITY,
    meta: { silentError: true },
  });
}

// Seeded from `updater:get` once on mount and then driven entirely by
// the `updater:state` broadcast -- no polling. The serving process is
// the single source of truth; the renderer just mirrors it. Reads its
// device from the host scope: this window's own updater with no
// provider mounted, or a peer's over its direct session inside one,
// so the same Settings card answers for whichever device is selected.
export function useUpdater() {
  const { deviceId, api, keys, remote } = useHostScope();
  const queryClient = useQueryClient();
  const query = useQuery(updaterStateQueryOptions(deviceId, api, remote));

  useEffect(
    () =>
      api.updater.onState((next) => {
        queryClient.setQueryData(keys.updaterState(), next);
      }),
    [api, keys, queryClient],
  );

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast above is the single source of truth; the host pushes the new state via setQueryData
  const check = useMutation({
    mutationFn: () => api.updater.check(),
    meta: { errorTitle: "Couldn't check for updates" },
  });
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast above is the single source of truth; the host pushes the new state via setQueryData
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
