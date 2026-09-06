import { useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useRuntimeInfo() {
  const { api, remote, keys } = useHostScope();
  return useQuery<RuntimeInfo>({
    queryKey: keys.runtimeInfo(),
    queryFn: () => api.runtime.info(),
    staleTime: Number.POSITIVE_INFINITY,
    // A peer that has not granted this device control refuses the
    // read. Its pages treat missing data as "no path to spell", which
    // is the honest answer, not an error to toast.
    meta: remote
      ? { silentError: true }
      : { errorTitle: "Couldn't read runtime info" },
  });
}
