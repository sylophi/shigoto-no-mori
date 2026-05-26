import { useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useRuntimeInfo() {
  return useQuery<RuntimeInfo>({
    queryKey: queryKeys.runtimeInfo(),
    queryFn: () => window.api.runtime.info(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read runtime info" },
  });
}
