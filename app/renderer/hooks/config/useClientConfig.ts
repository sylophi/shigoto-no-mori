import { useQuery } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// The app instance's client store (theme, palettes, villageLife,
// keepReachable),
// served by the client-scoped clientConfig module. Device-wide settings
// stay in useGlobalConfig. Every writer (the Settings save, the
// immediate patches, the palette rotation) funnels through
// mergeClientConfigWrite.
// Shared with the readers outside a component (the boot-time
// create-device move in lib/remote/sharedSettingsSync.ts, the palette
// rotation in lib/themeRotation.ts), so they hit the same cache entry
// under the same rule.
export const clientConfigQueryOptions = {
  queryKey: queryKeys.clientConfig(),
  queryFn: (): Promise<ClientConfig> => window.api.clientConfig.read(),
  // Every writer merges over this cached doc via mergeClientConfigWrite
  // and setQueryData's the result back, so the value can never change
  // behind this cache.
  staleTime: Number.POSITIVE_INFINITY,
};

export function useClientConfig() {
  return useQuery<ClientConfig>({
    ...clientConfigQueryOptions,
    meta: { errorTitle: "Couldn't load appearance settings" },
  });
}
