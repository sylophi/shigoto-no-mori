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

  const check = useMutation({
    mutationFn: () => window.api.updater.check(),
  });
  const install = useMutation({
    mutationFn: () => window.api.updater.install(),
  });

  return { state: query.data ?? null, check, install };
}
