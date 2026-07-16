import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Project } from "@shared/schemas";
import { reorderProjects } from "@shared/reorder";
import { queryKeys } from "@/lib/queryKeys";

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: queryKeys.projects(),
    queryFn: () => window.api.projects.list(),
    meta: { errorTitle: "Couldn't load projects" },
  });
}

// Refetch the projects list whenever main records a project action, so the
// usage-sorted sidebar ("most used" / "most recently used") reorders live.
// Call once at the App root; the subscriber owns its lifecycle.
export function useWatchProjectUsage(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.projects.onUsageBumped(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      }),
    [queryClient],
  );
}

export function useAddProject() {
  const queryClient = useQueryClient();
  return useMutation<Project, Error, string>({
    mutationFn: (path) => window.api.projects.add(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    meta: { errorTitle: "Couldn't add project" },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation<void, Error, string>({
    mutationFn: (id) => window.api.projects.remove(id),
    onMutate: async (id) => {
      // Cancel this project's in-flight fetches before main starts the
      // removal (mirrors the nuke path): left to settle, one would
      // reject with "Unknown project" during the awaits below and
      // toast, while cancellation is swallowed silently.
      await queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(id),
      });
    },
    onSuccess: async (_data, id) => {
      // Leave any route under the removed project before touching the
      // cache: its mounted queries (config, branches, diff, worktree
      // state, ...) would otherwise refetch against the unregistered id
      // on the next focus and each toast an "Unknown project" error.
      const { pathname } = router.state.location;
      if (pathname.startsWith(`/projects/${id}`)) {
        await router.navigate({ to: "/" });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      // With the route and sidebar row gone nothing observes the
      // removed project's queries; drop the leftovers so nothing can
      // replay them. Only inactive ones -- removing a query that still
      // has an observer (a row mid-unmount) would refetch it instead.
      queryClient.removeQueries({
        type: "inactive",
        predicate: (query) => query.queryKey.includes(id),
      });
    },
    meta: { errorTitle: "Couldn't remove project" },
  });
}

export function useReorderProjects() {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { draggedId: string; targetId: string; position: "before" | "after" },
    { previous?: Project[] }
  >({
    mutationFn: (input) => window.api.projects.reorder(input),
    onMutate: ({ draggedId, targetId, position }) => {
      // Synchronous on purpose: dnd-kit reads the active item's rect for
      // the drop animation right after onDragEnd returns. If the optimistic
      // reorder is awaited, React hasn't flushed by then and the overlay
      // animates back to the old slot before snapping. Cancel without
      // awaiting; cancelled in-flight fetches can't overwrite the cache.
      void queryClient.cancelQueries({ queryKey: queryKeys.projects() });
      const previous = queryClient.getQueryData<Project[]>(
        queryKeys.projects(),
      );
      queryClient.setQueryData<Project[]>(queryKeys.projects(), (current) =>
        current
          ? reorderProjects(current, draggedId, targetId, position)
          : current,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(queryKeys.projects(), context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    meta: { errorTitle: "Couldn't reorder projects" },
  });
}
