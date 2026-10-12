import { useQuery, skipToken } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useDefaultBranch(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.defaultBranch(projectId),
    queryFn:
      projectId !== null
        ? ({ signal }) =>
            api.run(api.projects.defaultBranch({ projectId }), { signal })
        : skipToken,
    meta: { errorTitle: "Couldn't resolve default branch" },
  });
}
