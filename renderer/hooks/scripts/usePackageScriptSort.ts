import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PackageScriptSortMode } from "@shared/schemas";
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

interface SortMutationContext {
  previous?: PackageScriptSortMode;
}

export function useSetPackageScriptSort(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, PackageScriptSortMode, SortMutationContext>({
    mutationFn: async (mode) => {
      if (!projectId) return;
      await window.api.packageScripts.setSort(projectId, mode);
    },
    onMutate: async (mode) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.packageScriptSort(projectId),
      });
      const previous = queryClient.getQueryData<PackageScriptSortMode>([
        "packageScriptSort",
        projectId,
      ]);
      queryClient.setQueryData(queryKeys.packageScriptSort(projectId), mode);
      return { previous };
    },
    onError: (_err, _mode, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(
          queryKeys.packageScriptSort(projectId),
          ctx.previous,
        );
      }
    },
    meta: { errorTitle: "Couldn't save script sort preference" },
  });
}
