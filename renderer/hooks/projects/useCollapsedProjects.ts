// Sidebar collapse state, persisted in the global state.json. The
// mutation sends a per-id toggle (not a whole-list write): the main
// process composes each toggle against disk, so rapid toggles and
// toggles fired before the initial query resolves can't lose or wipe
// state. The optimistic update mirrors the toggle functionally, then
// onSuccess syncs the cache to the list that actually landed on disk.
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

export function useToggleCollapsedProject() {
  const queryClient = useQueryClient();
  return useMutation<string[], Error, string>({
    mutationFn: (projectId) => window.api.projects.toggleCollapsed(projectId),
    onMutate: async (projectId) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.projectsCollapsed(),
      });
      queryClient.setQueryData<string[]>(
        queryKeys.projectsCollapsed(),
        (old = []) =>
          old.includes(projectId)
            ? old.filter((id) => id !== projectId)
            : [...old, projectId],
      );
    },
    onSuccess: (list) => {
      queryClient.setQueryData(queryKeys.projectsCollapsed(), list);
    },
    // Refetch instead of snapshot-rollback: a snapshot taken before an
    // overlapping toggle would clobber it; disk is the source of truth.
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectsCollapsed(),
      });
    },
    meta: { errorTitle: "Couldn't save collapsed projects" },
  });
}
