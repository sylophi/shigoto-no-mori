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
