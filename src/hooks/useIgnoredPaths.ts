import { useQuery } from "@tanstack/react-query";

export function useIgnoredPaths(projectId: string | null) {
  return useQuery<string[]>({
    queryKey: ["ignoredPaths", projectId],
    queryFn: () => {
      if (!projectId) return [];
      return window.api.projects.listIgnoredPaths(projectId);
    },
    enabled: projectId !== null,
    // Used inside the carry-over picker to grey out non-ignored entries.
    // The picker is modal, so a global spinner would be misleading.
    meta: { errorTitle: "Couldn't list ignored paths", silentSpinner: true },
  });
}
