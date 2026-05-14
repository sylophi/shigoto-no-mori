import { useQuery } from "@tanstack/react-query";
import type { BranchList } from "@shared/schemas";

export function useBranches(projectId: string | null) {
  return useQuery<BranchList>({
    queryKey: ["branches", projectId],
    queryFn: () => {
      if (!projectId) return { local: [], remote: [] };
      return window.api.projects.listBranches(projectId);
    },
    enabled: projectId !== null,
    staleTime: 30_000,
  });
}
