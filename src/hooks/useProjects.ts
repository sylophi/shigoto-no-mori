import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@shared/schemas";

const PROJECTS_KEY = ["projects"] as const;

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: PROJECTS_KEY,
    queryFn: () => window.api.projects.list(),
    staleTime: 30_000,
  });
}

export function useAddProject() {
  const queryClient = useQueryClient();
  return useMutation<Project, Error, string>({
    mutationFn: (path) => window.api.projects.add(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => window.api.projects.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

// Combined "open the native picker, then add the project" flow used by the
// sidebar footer and the empty-state CTA. Shared so they don't each do their
// own try/catch/invalidate dance.
export function useAddProjectFlow() {
  const addProject = useAddProject();
  return {
    isPending: addProject.isPending,
    error: addProject.error,
    start: async (): Promise<Project | null> => {
      const folder = await window.api.dialog.pickFolder();
      if (!folder) return null;
      try {
        return await addProject.mutateAsync(folder);
      } catch (error) {
        console.error("Failed to add project", error);
        return null;
      }
    },
  };
}
