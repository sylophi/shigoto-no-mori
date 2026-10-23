import { queryOptions, useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shigomori/contracts/schemas";
import { type HostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { queryKeysFor } from "@/lib/queryKeys";

// Single source of truth for a host's runtime info, so a read of this
// machine's from under a peer's scope (the pull dialogs' clone section)
// shares the cache entry with the scoped hook below.
export function runtimeInfoQueryOptions(
  scope: Pick<HostScope, "deviceId" | "api">,
  enabled = true,
) {
  const { deviceId, api } = scope;
  return queryOptions<RuntimeInfo>({
    queryKey: queryKeysFor(deviceId).runtimeInfo(),
    queryFn: ({ signal }) => {
      if (!api) throw new Error("no session to read runtime info over");
      return api.run(api.runtime.info(), { signal });
    },
    staleTime: Number.POSITIVE_INFINITY,
    enabled: enabled && api !== undefined,
    meta: { errorTitle: "Couldn't read runtime info" },
  });
}

export function useRuntimeInfo() {
  return useQuery(runtimeInfoQueryOptions(useHostScope()));
}
