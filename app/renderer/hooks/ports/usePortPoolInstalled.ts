import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function usePortPoolInstalled() {
  const { api, keys } = useHostScope();
  return useQuery<boolean>({
    queryKey: keys.portPoolInstalled(),
    queryFn: ({ signal }) => api.run(api.portPool.isInstalled(), { signal }),
    meta: { errorTitle: "Couldn't check if port-pool is installed" },
  });
}
