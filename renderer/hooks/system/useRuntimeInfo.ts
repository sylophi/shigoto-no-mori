import { useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useRuntimeInfo() {
  const { api, keys } = useHostScope();
  return useQuery<RuntimeInfo>({
    queryKey: keys.runtimeInfo(),
    queryFn: () => api.runtime.info(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read runtime info" },
  });
}
