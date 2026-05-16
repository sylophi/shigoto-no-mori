import { useQuery } from "@tanstack/react-query";
import type { PackageScriptsResult } from "@shared/schemas";

export function usePackageScripts(
  projectId: string | null,
  worktreeId: string | null,
) {
  return useQuery<PackageScriptsResult | null>({
    queryKey: ["packageScripts", projectId, worktreeId],
    queryFn: () => {
      if (!projectId || !worktreeId) return null;
      return window.api.packageScripts.list({ projectId, worktreeId });
    },
    enabled: projectId !== null && worktreeId !== null,
    meta: { errorTitle: "Couldn't read package.json scripts" },
  });
}
