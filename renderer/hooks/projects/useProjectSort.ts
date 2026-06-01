import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSortMode } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useProjectSort() {
  return useQuery<ProjectSortMode>({
    queryKey: queryKeys.projectsSort(),
    queryFn: () => window.api.projects.getSort(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read project sort preference" },
  });
}

interface SortMutationContext {
  previous?: ProjectSortMode;
}

export function useSetProjectSort() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, ProjectSortMode, SortMutationContext>({
    mutationFn: (mode) => window.api.projects.setSort(mode),
    onMutate: async (mode) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projectsSort() });
      const previous = queryClient.getQueryData<ProjectSortMode>(
        queryKeys.projectsSort(),
      );
      queryClient.setQueryData(queryKeys.projectsSort(), mode);
      return { previous };
    },
    onError: (_err, _mode, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.projectsSort(), ctx.previous);
      }
    },
    meta: { errorTitle: "Couldn't save project sort preference" },
  });
}
