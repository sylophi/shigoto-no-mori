import { useQuery } from "@tanstack/react-query";
import type { RuntimeInfo } from "@shared/channels";

export function useRuntimeInfo() {
  return useQuery<RuntimeInfo>({
    queryKey: ["runtime", "info"],
    queryFn: () => window.api.runtime.info(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
