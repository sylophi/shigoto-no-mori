import { useQuery, skipToken } from "@tanstack/react-query";
import type { PackageScriptsResult } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function usePackageScripts(
  projectId: string | null,
  worktreeId: string | null,
) {
  const { api, keys } = useHostScope();
  return useQuery<PackageScriptsResult | null>({
    queryKey: keys.packageScripts(projectId, worktreeId),
    queryFn:
      projectId !== null && worktreeId !== null
        ? () => api.packageScripts.list({ projectId, worktreeId })
        : skipToken,
    // Lock the sorted order for the route-mount's lifetime so a script
    // bumping its use count doesn't reshuffle the list mid-interaction;
    // matches useLauncherForProject.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorTitle: "Couldn't read package.json scripts" },
  });
}
