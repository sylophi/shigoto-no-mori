import { useMutation, useQuery } from "@tanstack/react-query";
import type { DetectedLauncher, LauncherEntry } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export function useDetectedLaunchers() {
  return useQuery<DetectedLauncher[]>({
    queryKey: queryKeys.detectedLaunchers(),
    queryFn: () => window.api.launchers.detect(),
    // Detection spawns ~15 `which` calls; cache for the session. The
    // answer only changes when the user installs/removes an app.
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't detect installed tools" },
  });
}

interface LauncherForProjectResult {
  entries: LauncherEntry[];
  // Resolvable entries the user hid in Settings. Only used to explain an
  // otherwise-empty row.
  hiddenCount: number;
}

export function useLauncherForProject(projectId: string | null) {
  return useQuery<LauncherForProjectResult>({
    queryKey: queryKeys.projectLaunchers(projectId),
    queryFn: () => {
      if (!projectId) return { entries: [], hiddenCount: 0 };
      return window.api.launchers.forProject(projectId);
    },
    enabled: projectId !== null,
    // Lock the order for the lifetime of the route mount. The page picks
    // up a fresh list when the user navigates in (refetchOnMount: "always"
    // from the global default), but never reshuffles under them on window
    // focus or reconnect.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorTitle: "Couldn't load launchers" },
  });
}

interface LaunchInput {
  projectId: string;
  worktreeId: string;
  launcherId: string;
}

export function useLaunch() {
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- by design: useLauncherForProject pins order for the route mount so the visible list doesn't reshuffle mid-interaction when bumpUseCount fires
  return useMutation<void, Error, LaunchInput>({
    mutationFn: (input) => window.api.launchers.launch(input),
    meta: { errorTitle: "Couldn't launch" },
  });
}
