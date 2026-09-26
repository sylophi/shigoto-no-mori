import { useQuery, skipToken } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useDefaultBranch(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.defaultBranch(projectId),
    queryFn:
      projectId !== null
        ? () => api.projects.defaultBranch(projectId)
        : skipToken,
    meta: { errorTitle: "Couldn't resolve default branch" },
  });
}
