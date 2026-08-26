import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function usePortPoolActive(projectId: string, worktreeId: string) {
  const { api, keys } = useHostScope();
  return useQuery<boolean>({
    queryKey: keys.portPoolActive(projectId, worktreeId),
    queryFn: () => api.portPool.isActive({ projectId, worktreeId }),
    meta: { errorTitle: "Couldn't check port-pool config" },
  });
}
