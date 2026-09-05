import { useQuery } from "@tanstack/react-query";
import type { ReadGlobalConfig } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { hasLocalHost } from "@/lib/localHost";

// Read side of the device config. The read is REDACTED: socketHost.token
// is absent (a derived tokenSet boolean stands in) and remoteDevices is
// dropped, so the type is ReadGlobalConfig rather than the full stored
// doc. The hosting and remote-device sections source their real tokens
// from window.api.globalConfig.readLocal instead. Writes go through
// useSettingsSave, which owns the dirty diff and the post-save
// invalidations.
// silentError lets a call site that renders its own inline read error
// (the remote settings pane) suppress the global error toast, so a
// failed read is signalled once, not twice. A hostless client has no
// local device config at all, so the local scope's read never runs
// there (a peer's does).
export function useGlobalConfig({ silentError = false } = {}) {
  const { api, keys, remote } = useHostScope();
  return useQuery<ReadGlobalConfig>({
    queryKey: keys.globalConfig(),
    queryFn: () => api.globalConfig.read(),
    enabled: remote || hasLocalHost,
    meta: silentError
      ? { silentError: true }
      : { errorTitle: "Couldn't load settings" },
  });
}
