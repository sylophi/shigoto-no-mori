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

export const NO_ORDER: readonly string[] = [];

// The stored "manual" order, read only while the sort is manual: the
// list reads it for nothing else, and a host too old to know the call
// never reports a manual sort, so it's never asked.
export function usePackageScriptOrder(
  projectId: string | null,
  sortMode: PackageScriptSortMode,
) {
  const { api, keys } = useHostScope();
  return useQuery<string[]>({
    queryKey: keys.packageScriptOrder(projectId),
    queryFn: () => {
      if (!projectId) return [];
      return api.packageScripts.getOrder(projectId);
    },
    enabled: projectId !== null && sortMode === "manual",
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read script order" },
  });
}

// Takes one worktree's scripts in their arranged order. That is also the
// optimistic value, which orders this worktree's list exactly as the
// host's merged order will. The refetch once the write settles brings
// in the names only other branches have.
export function useSetPackageScriptOrder(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useOptimisticPreference<string[]>(
    keys.packageScriptOrder(projectId),
    async (arranged) => {
      if (!projectId) return;
      await api.packageScripts.setOrder(projectId, arranged);
    },
    "Couldn't save script order",
  );
}
