import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useIgnoredPaths(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<string[]>({
    queryKey: keys.ignoredPaths(projectId),
    queryFn: () => {
      if (!projectId) return [];
      return api.projects.listIgnoredPaths(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't list ignored paths" },
  });
}
