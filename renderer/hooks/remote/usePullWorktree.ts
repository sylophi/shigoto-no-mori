// The pull: a peer's worktree lands on this machine. The transplant
// dialog drives it directly and the mirror start runs it under its
// own orchestration. Capture, transfer, create, and dirty apply ride a
// single pending state. The pull's running commentary streams
// separately (usePullProgress). The handler re-verifies the identity
// match, so the gate at the call sites is UX, not the wall. Refusals
// surface centrally, and the outcome is the caller's to report: the
// dialog's last step is the report, and the mirror lands through
// reportLanded below.
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { SyncPullWorktreeResult } from "@shared/ipc/modules/sync";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateHostDevice, queryKeys } from "@/lib/queryKeys";

// The teardown reports a kept source with its raw reason. scripts-running
// is the one code worth spelling out, and every surface that reports a
// kept source says it from here. Phrased for mid-sentence use, which is
// where both callers put it.
export function keptSourceReason(
  sourceError: string | undefined,
): string | undefined {
  return sourceError !== undefined && sourceError.includes("scripts-running")
    ? "scripts are still running there."
    : sourceError;
}

// What every pull-shaped landing does once the worktree is here: the
// local forest's registry keys refresh. The outcome is the caller's
// to report (the dialogs' last step is the report). Shared with the
// mirror start, which lands the same way.
export function invalidateLanded(
  queryClient: QueryClient,
  localProjectId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.worktrees(localProjectId),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.branches(localProjectId),
  });
}

export function usePullWorktree({
  worktree,
  sourceProjectId,
  sourceIdentity,
  localProjectId,
}: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
}) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<SyncPullWorktreeResult> =>
      window.api.sync.pullWorktree({
        sourceDeviceId: deviceId,
        sourceProjectId,
        sourceWorktreeId: worktree.id,
        sourceIdentity,
        branch: worktree.branch,
      }),
    // The invalidations only: the caller shows the outcome, so the
    // conclusion is told once.
    onSuccess: () => invalidateLanded(queryClient, localProjectId),
    meta: { silentError: true },
  });
}

// The transplant's second half: tear the source worktree down on the
// peer after a pull landed it here. A refused or failed teardown is a
// partial success the handler returns instead of throwing (the
// worktree simply exists on both devices), so the caller reads
// sourceRemoved and speaks for it. Only a call that never got that far
// rejects. The peer's whole cached view is invalidated, the same sweep
// its own resolved-mutation ping runs.
export function useTeardownSource({
  worktree,
  sourceProjectId,
}: {
  worktree: Worktree;
  sourceProjectId: string;
}) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      window.api.sync.teardownSource({
        sourceDeviceId: deviceId,
        sourceProjectId,
        sourceWorktreeId: worktree.id,
      }),
    onSuccess: () => invalidateHostDevice(queryClient, deviceId),
    meta: { errorTitle: "Couldn't tear down the source worktree" },
  });
}
