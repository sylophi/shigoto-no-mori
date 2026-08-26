import { useQuery } from "@tanstack/react-query";
import type { GlobalConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Read side of the device config. Writes go through useSettingsSave,
// which owns the dirty diff and the post-save invalidations.
export function useGlobalConfig() {
  return useQuery<GlobalConfig>({
    queryKey: queryKeys.globalConfig(),
    queryFn: () => window.api.globalConfig.read(),
    meta: { errorTitle: "Couldn't load settings" },
  });
}
