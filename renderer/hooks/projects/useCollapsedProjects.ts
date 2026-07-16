// Sidebar collapse state, persisted in the global state.json alongside
// the sort preference. The mutation is optimistic so toggling feels
// instant; the write itself is fire-and-forget.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function useCollapsedProjects() {
  return useQuery<string[]>({
    queryKey: queryKeys.projectsCollapsed(),
    queryFn: () => window.api.projects.getCollapsed(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read collapsed projects" },
  });
}

interface CollapsedMutationContext {
  previous?: string[];
}

export function useSetCollapsedProjects() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string[], CollapsedMutationContext>({
    mutationFn: (ids) => window.api.projects.setCollapsed(ids),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.projectsCollapsed(),
      });
      const previous = queryClient.getQueryData<string[]>(
        queryKeys.projectsCollapsed(),
      );
      queryClient.setQueryData(queryKeys.projectsCollapsed(), ids);
      return { previous };
    },
    onError: (_err, _ids, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.projectsCollapsed(), ctx.previous);
      }
    },
    meta: { errorTitle: "Couldn't save collapsed projects" },
  });
}
