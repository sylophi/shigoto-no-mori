import { useQuery } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// The app instance's client store (theme, doubutsu, keepReachable),
// served by the client-scoped clientConfig module. Device-wide settings
// stay in useGlobalConfig. Three writers exist (useSettingsSave,
// useKeepReachableUpdate, and the web AppearancePage save) and every one
// funnels through mergeClientConfigWrite.
export function useClientConfig() {
  return useQuery<ClientConfig>({
    queryKey: queryKeys.clientConfig(),
    queryFn: () => window.api.clientConfig.read(),
    // Every writer merges over this cached doc via mergeClientConfigWrite
    // and setQueryData's the result back, so the value can never change
    // behind this cache.
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't load appearance settings" },
  });
}
