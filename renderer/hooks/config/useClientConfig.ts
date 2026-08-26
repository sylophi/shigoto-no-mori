import { useQuery } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// The app instance's appearance store (theme, doubutsu), served by the
// client-scoped clientConfig module. Device-wide settings stay in
// useGlobalConfig. Writes go through useSettingsSave, which is also the
// only writer of this cache entry.
export function useClientConfig() {
  return useQuery<ClientConfig>({
    queryKey: queryKeys.clientConfig(),
    queryFn: () => window.api.clientConfig.read(),
    // The store's only writer is the save mutation (useSettingsSave),
    // which setQueryData's the new doc, so the value can never change
    // behind this cache.
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't load appearance settings" },
  });
}
