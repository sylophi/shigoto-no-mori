import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PackageScriptSortMode } from "@shared/schemas";

const DEFAULT_MODE: PackageScriptSortMode = "default";

export function usePackageScriptSort(projectId: string | null) {
  return useQuery<PackageScriptSortMode>({
    queryKey: ["packageScriptSort", projectId],
    queryFn: () => {
      if (!projectId) return DEFAULT_MODE;
      return window.api.packageScripts.getSort(projectId);
    },
    enabled: projectId !== null,
    // The preference doesn't change behind our back; once loaded, the mode
    // sticks for the session unless the user picks a new one (which writes
    // through the mutation below).
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read script sort preference" },
  });
}

export function useSetPackageScriptSort(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, PackageScriptSortMode>({
    mutationFn: async (mode) => {
      if (!projectId) return;
      await window.api.packageScripts.setSort(projectId, mode);
    },
    onMutate: async (mode) => {
      await queryClient.cancelQueries({
        queryKey: ["packageScriptSort", projectId],
      });
      const previous = queryClient.getQueryData<PackageScriptSortMode>([
        "packageScriptSort",
        projectId,
      ]);
      queryClient.setQueryData(["packageScriptSort", projectId], mode);
      return { previous };
    },
    onError: (_err, _mode, ctx) => {
      const previous = (ctx as { previous?: PackageScriptSortMode } | undefined)
        ?.previous;
      if (previous !== undefined) {
        queryClient.setQueryData(["packageScriptSort", projectId], previous);
      }
    },
    meta: { errorTitle: "Couldn't save script sort preference" },
  });
}
