import { queryOptions, useQuery } from "@tanstack/react-query";
import type { PackageScriptsResult } from "@shigomori/contracts/schemas";
import { type HostScope, useHostScope } from "@/hooks/remote/useHostScope";

export function packageScriptsQuery(
  { api, keys }: Pick<HostScope, "api" | "keys">,
  projectId: string,
  worktreeId: string,
) {
  return queryOptions<PackageScriptsResult | null>({
    queryKey: keys.packageScripts(projectId, worktreeId),
    queryFn: ({ signal }) =>
      api.run(api.packageScripts.list({ projectId, worktreeId }), {
        signal,
      }),
    // Lock the sorted order while cached so a script bumping its use
    // count doesn't reshuffle the list mid-interaction.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorTitle: "Couldn't read scripts" },
  });
}

export function usePackageScripts(projectId: string, worktreeId: string) {
  return useQuery(packageScriptsQuery(useHostScope(), projectId, worktreeId));
}
