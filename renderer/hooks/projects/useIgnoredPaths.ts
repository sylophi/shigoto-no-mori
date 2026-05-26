import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function useIgnoredPaths(projectId: string | null) {
  return useQuery<string[]>({
    queryKey: queryKeys.ignoredPaths(projectId),
    queryFn: () => {
      if (!projectId) return [];
      return window.api.projects.listIgnoredPaths(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't list ignored paths" },
  });
}
