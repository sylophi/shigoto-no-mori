import { useMutation, useQuery, skipToken } from "@tanstack/react-query";
import type {
  DetectedLauncher,
  LauncherEntry,
} from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function useDetectedLaunchers() {
  const { api, keys } = useHostScope();
  return useQuery<readonly DetectedLauncher[]>({
    queryKey: keys.detectedLaunchers(),
    queryFn: ({ signal }) => api.run(api.launchers.detect(), { signal }),
    // Detection spawns ~15 `which` calls, and the answer only changes
    // when the user installs or removes an app: kept between reads, and
    // read again each time Settings shows the tools.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
    meta: { errorTitle: "Couldn't detect installed tools" },
  });
}

interface LauncherForProjectResult {
  readonly entries: readonly LauncherEntry[];
  // Resolvable entries the user hid in Settings. Only used to explain an
  // otherwise-empty row.
  readonly hiddenCount: number;
}

export function useLauncherForProject(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<LauncherForProjectResult>({
    queryKey: keys.projectLaunchers(projectId),
    queryFn:
      projectId !== null
        ? ({ signal }) =>
            api.run(api.launchers.forProject({ projectId }), { signal })
        : skipToken,
    // Lock the order for the lifetime of the route mount. The page picks
    // up a fresh list when the user navigates in, but never reshuffles
    // under them on window focus or reconnect.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
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
  const { api } = useHostScope();
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- by design: useLauncherForProject pins order for the route mount so the visible list doesn't reshuffle mid-interaction when bumpUseCount fires
  return useMutation<void, Error, LaunchInput>({
    mutationFn: (input) => api.run(api.launchers.launch(input)),
    meta: { errorTitle: "Couldn't launch" },
  });
}

// Opens a worktree's file in this machine's editor (the editor
// setting, or the file's default app), or undefined on a peer's page,
// whose files are on the peer.
export function useOpenInEditor(worktree: {
  projectId: string;
  id: string;
}): ((path: string) => void) | undefined {
  const { api, remote } = useHostScope();
  const { mutate } = useMutation<void, Error, string>({
    mutationFn: (path) =>
      api.run(
        api.launchers.openFile({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          path,
        }),
      ),
    meta: { errorTitle: "Couldn't open the file" },
  });
  return remote ? undefined : mutate;
}
