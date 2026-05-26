import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function useDefaultBranch(projectId: string | null) {
  return useQuery<string>({
    queryKey: queryKeys.defaultBranch(projectId),
    queryFn: () => {
      if (!projectId) throw new Error("projectId required");
      return window.api.projects.defaultBranch(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't resolve default branch" },
  });
}
