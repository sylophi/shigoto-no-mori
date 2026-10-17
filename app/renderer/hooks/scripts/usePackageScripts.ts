import { useQuery, skipToken } from "@tanstack/react-query";
import type { PackageScriptsResult } from "@shigomori/contracts/schemas";
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
        ? ({ signal }) =>
            api.run(api.packageScripts.list({ projectId, worktreeId }), {
              signal,
            })
        : skipToken,
    // Lock the sorted order while cached so a script bumping its use
    // count doesn't reshuffle the list mid-interaction.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorTitle: "Couldn't read scripts" },
  });
}
