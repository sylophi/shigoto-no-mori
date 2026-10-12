import { useQuery } from "@tanstack/react-query";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import { queryKeys } from "@/lib/queryKeys";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";

// The app instance's client store (theme, palettes, villageLife,
// keepReachable),
// served by the client-scoped clientConfig module. Device-wide settings
// stay in useGlobalConfig. Three writers exist (useSettingsSave,
// useKeepReachableUpdate, and the web AppearancePage save) and every one
// funnels through mergeClientConfigWrite.
// Shared with the one reader outside a component (the boot-time
// create-device move in lib/remote/sharedSettingsSync.ts), so both hit
// the same cache entry under the same rule.
export const clientConfigQueryOptions = (api: RendererApi) => ({
  queryKey: queryKeys.clientConfig(),
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<ClientConfig> =>
    api.run(api.clientConfig.read(), { signal }),
  // Every writer merges over this cached doc via mergeClientConfigWrite
  // and setQueryData's the result back, so the value can never change
  // behind this cache.
  staleTime: Number.POSITIVE_INFINITY,
});

export function useClientConfig() {
  return useQuery<ClientConfig>({
    ...clientConfigQueryOptions(useApi()),
    meta: { errorTitle: "Couldn't load appearance settings" },
  });
}
