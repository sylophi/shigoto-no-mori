import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@shared/schemas";

const PROJECTS_KEY = ["projects"] as const;

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: PROJECTS_KEY,
    queryFn: () => window.api.projects.list(),
    meta: { errorTitle: "Couldn't load projects" },
  });
}

export function useAddProject() {
  const queryClient = useQueryClient();
  return useMutation<Project, Error, string>({
    mutationFn: (path) => window.api.projects.add(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
    meta: { errorTitle: "Couldn't add project" },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => window.api.projects.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
    meta: { errorTitle: "Couldn't remove project" },
  });
}

function reorderProjects(
  projects: Project[],
  draggedId: string,
  targetId: string,
  position: "before" | "after",
): Project[] {
  if (draggedId === targetId) return projects;

  const draggedIndex = projects.findIndex((p) => p.id === draggedId);
  if (draggedIndex < 0) return projects;

  const next = [...projects];
  const [dragged] = next.splice(draggedIndex, 1);
  if (!dragged) return projects;

  const targetIndex = next.findIndex((p) => p.id === targetId);
  if (targetIndex < 0) return projects;

  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, dragged);
  return next;
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
      void queryClient.cancelQueries({ queryKey: PROJECTS_KEY });
      const previous = queryClient.getQueryData<Project[]>(PROJECTS_KEY);
      queryClient.setQueryData<Project[]>(PROJECTS_KEY, (current) =>
        current
          ? reorderProjects(current, draggedId, targetId, position)
          : current,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(PROJECTS_KEY, context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
    meta: { errorTitle: "Couldn't reorder projects" },
  });
}
