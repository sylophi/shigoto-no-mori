import { useQuery } from "@tanstack/react-query";
import type { PackageScriptSortMode } from "@shared/schemas";
import { useOptimisticPreference } from "@/hooks/ui/useOptimisticPreference";
import { useHostScope } from "@/hooks/remote/useHostScope";

const DEFAULT_MODE: PackageScriptSortMode = "frequent";

export function usePackageScriptSort(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<PackageScriptSortMode>({
    queryKey: keys.packageScriptSort(projectId),
    queryFn: () => {
      if (!projectId) return DEFAULT_MODE;
      return api.packageScripts.getSort(projectId);
    },
    enabled: projectId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read script sort preference" },
  });
}

export function useSetPackageScriptSort(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useOptimisticPreference<PackageScriptSortMode>(
    keys.packageScriptSort(projectId),
    async (mode) => {
      if (!projectId) return;
      await api.packageScripts.setSort(projectId, mode);
    },
    "Couldn't save script sort preference",
  );
}
