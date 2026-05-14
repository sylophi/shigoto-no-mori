import { useMutation, useQuery } from "@tanstack/react-query";
import type { DetectedLauncher, LauncherEntry } from "@shared/schemas";

export function useDetectedLaunchers() {
  return useQuery<DetectedLauncher[]>({
    queryKey: ["launchers", "detected"],
    queryFn: () => window.api.launchers.detected(),
    staleTime: 60_000,
  });
}

interface LauncherForProjectResult {
  entries: LauncherEntry[];
}

export function useLauncherForProject(projectId: string | null) {
  return useQuery<LauncherForProjectResult>({
    queryKey: ["launchers", projectId],
    queryFn: () => {
      if (!projectId) return { entries: [] };
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
