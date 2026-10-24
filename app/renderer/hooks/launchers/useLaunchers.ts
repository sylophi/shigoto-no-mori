import { useMutation, useQuery, skipToken } from "@tanstack/react-query";
import type {
  DetectedLauncher,
  Launched,
  LauncherEntry,
} from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";

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

const LAUNCHER_ROW_STALE_MS = 5 * 60_000;

export function useLauncherForProject(projectId: string | null) {
  const { api, keys } = useHostScope();
  return useQuery<LauncherForProjectResult>({
    queryKey: keys.projectLaunchers(projectId),
    queryFn:
      projectId !== null
        ? ({ signal }) =>
            api.run(api.launchers.forProject({ projectId }), { signal })
        : skipToken,
    // The order holds while the user works, and on window focus or
    // reconnect; a visit after a few minutes reads it again, a tool
    // installed meanwhile included.
    staleTime: LAUNCHER_ROW_STALE_MS,
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

// Shows the terminal in the app an open ran its tool in, if it did.
export function useShowAppTerminal() {
  const { deviceId } = useHostScope();
  const { toTerminalOn } = useWorktreeNav();
  return (
    { projectId, worktreeId }: { projectId: string; worktreeId: string },
    { terminalId }: Launched,
  ) => {
    if (terminalId !== undefined) {
      toTerminalOn(deviceId, projectId, worktreeId, terminalId);
    }
  };
}

export function useLaunch() {
  const { api } = useHostScope();
  const show = useShowAppTerminal();
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- by design: useLauncherForProject holds its order for minutes so the visible list doesn't reshuffle mid-interaction when bumpUseCount fires
  return useMutation<void, Error, LaunchInput>({
    mutationFn: (input) =>
      api
        .run(api.launchers.launch(input))
        .then((launched) => show(input, launched)),
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
  const show = useShowAppTerminal();
  const owner = { projectId: worktree.projectId, worktreeId: worktree.id };
  const { mutate } = useMutation<void, Error, string>({
    mutationFn: (path) =>
      api
        .run(api.launchers.openFile({ ...owner, path }))
        .then((launched) => show(owner, launched)),
    meta: { errorTitle: "Couldn't open the file" },
  });
  return remote ? undefined : mutate;
}
