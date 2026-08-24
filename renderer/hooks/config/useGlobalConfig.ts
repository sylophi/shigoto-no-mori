import { useQuery } from "@tanstack/react-query";
import type { ReadGlobalConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Read side of the device config. The read is REDACTED: socketHost.token
// is absent (a derived tokenSet boolean stands in) and remoteDevices is
// dropped, so the type is ReadGlobalConfig rather than the full stored
// doc. The hosting and remote-device sections source their real tokens
// from window.api.globalConfig.readLocal instead. Writes go through
// useSettingsSave, which owns the dirty diff and the post-save
// invalidations.
export function useGlobalConfig() {
  return useQuery<ReadGlobalConfig>({
    queryKey: queryKeys.globalConfig(),
    queryFn: () => window.api.globalConfig.read(),
    meta: { errorTitle: "Couldn't load settings" },
  });
}
