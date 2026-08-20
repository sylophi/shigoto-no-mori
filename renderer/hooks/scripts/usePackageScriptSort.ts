import { useQuery } from "@tanstack/react-query";
import type { PackageScriptSortMode } from "@shared/schemas";
import { useOptimisticPreference } from "@/hooks/ui/useOptimisticPreference";
import { queryKeys } from "@/lib/queryKeys";

const DEFAULT_MODE: PackageScriptSortMode = "frequent";

export function usePackageScriptSort(projectId: string | null) {
  return useQuery<PackageScriptSortMode>({
    queryKey: queryKeys.packageScriptSort(projectId),
    queryFn: () => {
      if (!projectId) return DEFAULT_MODE;
      return window.api.packageScripts.getSort(projectId);
    },
    enabled: projectId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read script sort preference" },
  });
}

export function useSetPackageScriptSort(projectId: string | null) {
  return useOptimisticPreference<PackageScriptSortMode>(
    queryKeys.packageScriptSort(projectId),
    async (mode) => {
      if (!projectId) return;
      await window.api.packageScripts.setSort(projectId, mode);
    },
    "Couldn't save script sort preference",
  );
}
