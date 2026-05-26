import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  return useMutation<void, Error, string>({
    mutationFn: (id) => window.api.projects.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
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
