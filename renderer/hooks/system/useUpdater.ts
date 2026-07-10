import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdaterState } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Seeded from `updater:get` once on mount and then driven entirely by
// the `updater:state` broadcast -- no polling. The main process is the
// single source of truth; the renderer just mirrors it.
export function useUpdater() {
  const queryClient = useQueryClient();
  const query = useQuery<UpdaterState>({
    queryKey: queryKeys.updaterState(),
    queryFn: () => window.api.updater.get(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(
    () =>
      window.api.updater.onState((next) => {
        queryClient.setQueryData(queryKeys.updaterState(), next);
      }),
    [queryClient],
  );

  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast above is the single source of truth; main pushes the new state via setQueryData
  const check = useMutation({
    mutationFn: () => window.api.updater.check(),
  });
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- the updater:state broadcast above is the single source of truth; main pushes the new state via setQueryData
  const install = useMutation({
    mutationFn: () => window.api.updater.install(),
  });

  // The explicit annotation strips react-query's NoInfer wrapper from
  // `data`; tsgo (TypeScript 7) can't narrow the discriminated union
  // through the intrinsic NoInfer that query-core 5.101 switched to.
  const state: UpdaterState | null = query.data ?? null;
  return { state, check, install };
}
