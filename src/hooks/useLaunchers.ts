import { useMutation, useQuery } from "@tanstack/react-query";
import type { DetectedLauncher, LauncherEntry } from "@shared/schemas";

export function useDetectedLaunchers() {
  return useQuery<DetectedLauncher[]>({
    queryKey: ["launchers", "detected"],
    queryFn: () => window.api.launchers.detected(),
    // Detection spawns ~15 `which` calls; cache for the session. The
    // answer only changes when the user installs/removes an app.
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't detect installed tools" },
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
    meta: { errorTitle: "Couldn't load launchers" },
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
    meta: { errorTitle: "Couldn't launch" },
  });
}
