import { useQuery } from "@tanstack/react-query";

export function useDefaultBranch(projectId: string | null) {
  return useQuery<string>({
    queryKey: ["defaultBranch", projectId],
    queryFn: () => {
      if (!projectId) throw new Error("projectId required");
      return window.api.projects.defaultBranch(projectId);
    },
    enabled: projectId !== null,
    staleTime: 30_000,
  });
}
