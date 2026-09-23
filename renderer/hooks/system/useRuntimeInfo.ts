import { queryOptions, useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  type HostForestScope,
  resolveForestScope,
} from "@/hooks/worktrees/useWorktrees";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";

// Single source of truth for a host's runtime info, so a read of this
// machine's from under a peer's scope (the pull dialogs' clone section)
// shares the cache entry with the scoped hook below. The scope rule is
// resolveForestScope's: this machine unless one is named.
export function runtimeInfoQueryOptions(
  scope: HostForestScope = {},
  enabled = true,
) {
  const { deviceId, api } = resolveForestScope(scope);
  return queryOptions<RuntimeInfo>({
    queryKey: queryKeysFor(deviceId).runtimeInfo(),
    queryFn: () => {
      if (!api) throw new Error("no session to read runtime info over");
      return api.runtime.info();
    },
    staleTime: Number.POSITIVE_INFINITY,
    enabled: enabled && api !== undefined,
    // A peer's pages treat a refused read as "no path to spell".
    meta: gatedHostReadMeta(
      deviceId !== localDeviceId,
      "Couldn't read runtime info",
    ),
  });
}

export function useRuntimeInfo() {
  return useQuery(runtimeInfoQueryOptions(useHostScope()));
}
