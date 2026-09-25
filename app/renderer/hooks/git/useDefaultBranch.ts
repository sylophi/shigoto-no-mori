import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useDefaultBranch(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.defaultBranch(projectId),
    queryFn: () => {
      if (!projectId) throw new Error("projectId required");
      return api.projects.defaultBranch(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't resolve default branch" },
  });
}
