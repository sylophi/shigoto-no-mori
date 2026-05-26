import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function usePortPoolActive(projectId: string, worktreeId: string) {
  return useQuery<boolean>({
    queryKey: queryKeys.portPoolActive(projectId, worktreeId),
    queryFn: () => window.api.portPool.isActive({ projectId, worktreeId }),
    meta: { errorTitle: "Couldn't check port-pool config" },
  });
}
