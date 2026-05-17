import { useQuery } from "@tanstack/react-query";

export function useIgnoredPaths(projectId: string | null) {
  return useQuery<string[]>({
    queryKey: ["ignoredPaths", projectId],
    queryFn: () => {
      if (!projectId) return [];
      return window.api.projects.listIgnoredPaths(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't list ignored paths" },
  });
}
