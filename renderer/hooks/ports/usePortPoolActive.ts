import { useQuery } from "@tanstack/react-query";

export function usePortPoolActive(projectId: string, worktreeId: string) {
  return useQuery<boolean>({
    queryKey: ["portPoolActive", projectId, worktreeId],
    queryFn: () => window.api.portPool.isActive({ projectId, worktreeId }),
    meta: { errorTitle: "Couldn't check port-pool config" },
  });
}
