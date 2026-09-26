import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PackageScriptSortMode,
  PackageScriptsResult,
} from "@shared/schemas";
import {
  sortEntries,
  type SortableEntry,
} from "@/components/worktreeDetail/scripts/sortPackageScripts";
import { withLaunchRowScript } from "@shared/launchRow";
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

// A worktree's package.json scripts in the project's chosen order: the
// one order the Scripts section, the launch row and the ⌘K palette all
// list them in. Empty while `pkg` is still being read, or absent.
export function useSortedPackageScripts(
  projectId: string,
  pkg: PackageScriptsResult | null | undefined,
): { sortMode: PackageScriptSortMode; sorted: SortableEntry[] } {
  const { data: sortMode = DEFAULT_MODE } = usePackageScriptSort(projectId);
  const { data: order = NO_ORDER } = usePackageScriptOrder(projectId, sortMode);
  const sorted = pkg
    ? sortEntries(Object.entries(pkg.scripts), sortMode, pkg.usage, order)
    : [];
  return { sortMode, sorted };
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

// Puts one script on the launch row or takes it off. The picks ride
// every worktree's listing, so the optimistic value goes into each of
// the project's cached listings, and the refetch once the last write
// settles has the host's say (and undoes a failed write). Only the last:
// a refetch while another toggle is in flight would read the host from
// before it and drop that toggle's pin until it settles.
export function useSetLaunchRowScript(projectId: string | null) {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  const queryKey = keys.packageScriptsAll(projectId);
  const mutationKey = ["setLaunchRow", ...queryKey];
  return useMutation<void, Error, { scriptName: string; onRow: boolean }>({
    mutationKey,
    mutationFn: async ({ scriptName, onRow }) => {
      if (!projectId) return;
      await api.packageScripts.setLaunchRow(projectId, scriptName, onRow);
    },
    onMutate: ({ scriptName, onRow }) => {
      void queryClient.cancelQueries({ queryKey });
      queryClient.setQueriesData<PackageScriptsResult | null>(
        { queryKey },
        (pkg) => {
          if (!pkg) return pkg;
          const launchRow = pkg.launchRow ?? [];
          return {
            ...pkg,
            launchRow: withLaunchRowScript(launchRow, scriptName, onRow),
          };
        },
      );
    },
    // This mutation still counts as pending while it settles.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      return queryClient.invalidateQueries({ queryKey });
    },
    meta: { errorTitle: "Couldn't update the Launch section" },
  });
}
