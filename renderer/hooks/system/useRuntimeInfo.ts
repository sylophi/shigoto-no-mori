import { useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { gatedHostReadMeta } from "@/lib/queryClientOptions";

export function useRuntimeInfo() {
  const { api, remote, keys } = useHostScope();
  return useQuery<RuntimeInfo>({
    queryKey: keys.runtimeInfo(),
    queryFn: () => api.runtime.info(),
    staleTime: Number.POSITIVE_INFINITY,
    // A peer's pages treat a refused read as "no path to spell".
    meta: gatedHostReadMeta(remote, "Couldn't read runtime info"),
  });
}
