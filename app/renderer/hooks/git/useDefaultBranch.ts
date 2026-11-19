import { useQuery } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useDefaultBranch(projectId: string) {
  const { api, keys } = useHostScope();
  return useQuery<string>({
    queryKey: keys.defaultBranch(projectId),
    queryFn: ({ signal }) =>
      api.run(api.projects.defaultBranch({ projectId }), { signal }),
    meta: { errorTitle: "Couldn't resolve the default branch" },
  });
}
