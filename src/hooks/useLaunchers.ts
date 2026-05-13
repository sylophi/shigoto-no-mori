import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LauncherEntry } from "@shared/schemas";

interface LauncherForProjectResult {
  entries: LauncherEntry[];
  preferred: string | null;
}

export function useLauncherForProject(projectId: string | null) {
  return useQuery<LauncherForProjectResult>({
    queryKey: ["launchers", projectId],
    queryFn: () => {
      if (!projectId) return { entries: [], preferred: null };
      return window.api.launchers.forProject(projectId);
    },
    enabled: projectId !== null,
    staleTime: 30_000,
  });
}

interface LaunchInput {
  projectId: string;
  worktreeId: string;
  launcherId: string;
}

export function useLaunch() {
  return useMutation<void, Error, LaunchInput>({
    mutationFn: (input) => window.api.launchers.launch(input),
  });
}

interface SetPreferredInput {
  projectId: string;
  launcherId: string;
}

export function useSetPreferredLauncher() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, SetPreferredInput>({
    mutationFn: (input) => window.api.launchers.setPreferred(input),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["launchers", vars.projectId],
      });
    },
  });
}
