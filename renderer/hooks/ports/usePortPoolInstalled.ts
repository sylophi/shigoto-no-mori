import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function usePortPoolInstalled() {
  return useQuery<boolean>({
    queryKey: queryKeys.portPoolInstalled(),
    queryFn: () => window.api.portPool.isInstalled(),
    meta: { errorTitle: "Couldn't check if port-pool is installed" },
  });
}
