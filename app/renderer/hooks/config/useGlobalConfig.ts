import { queryOptions, useQuery } from "@tanstack/react-query";
import type { GlobalConfig } from "@shared/schemas";
import { type HostReadScope, useHostScope } from "@/hooks/remote/useHostScope";
import { hasLocalHost } from "@/lib/localHost";
import { queryKeys } from "@/lib/queryKeys";

// Read side of the device config. Writes go through useSettingsSave
// (this machine) and useDeviceSettingsSave (a peer), which own the dirty
// diff and the post-save invalidations.
// silentError lets a call site that renders its own inline read error
// (the remote settings pane) suppress the global error toast, so a
// failed read is signalled once, not twice. A hostless client has no
// local device config at all, so the local scope's read never runs
// there (a peer's does).
export function useGlobalConfig({ silentError = false } = {}) {
  const scope = useHostScope();
  return useQuery({
    ...globalConfigQueryOptions(scope),
    enabled: scope.hasHost,
    meta: silentError
      ? { silentError: true }
      : { errorTitle: "Couldn't load settings" },
  });
}

// The read itself, for a caller outside React (the villager toasts,
// lib/villagers/speakers.ts) sharing the hook's cache entry.
// Silent on its own: a caller that wants a failed read said out loud
// (the hooks above) sets its own meta.
export function globalConfigQueryOptions(scope: HostReadScope) {
  return queryOptions<GlobalConfig>({
    queryKey: scope.keys.globalConfig(),
    queryFn: () => scope.api.globalConfig.read(),
    meta: { silentError: true },
  });
}

// The same read pinned to THIS machine whatever scope the caller sits
// under, for the preferences that belong to the device doing the viewing
// (launchScripts on a peer's worktree page). Shares the local scope's
// cache entry, so it is warm from boot. Never runs on a hostless client.
export function useLocalGlobalConfig() {
  return useQuery({
    ...globalConfigQueryOptions({ api: window.api, keys: queryKeys }),
    enabled: hasLocalHost,
    meta: { errorTitle: "Couldn't load settings" },
  });
}
