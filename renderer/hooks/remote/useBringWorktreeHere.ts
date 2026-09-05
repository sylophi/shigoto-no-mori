// The one bring-a-peer's-worktree-here mutation (the pull), shared by the remote worktree detail's footer and its transplant
// dialog: capture, transfer, create, and dirty apply ride a single
// pending state -- the pull's running commentary streams separately
// (usePullProgress). The handler re-verifies the identity match, so
// the gate at the call sites is UX, not the wall. Refusals surface
// centrally, everything else toasts here: the result lands on another
// page (the local worktree), so the toast is usually the only visible
// conclusion -- a caller that shows the outcome itself passes `quiet`.
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type { SyncPullWorktreeResult } from "@shared/ipc/modules/sync";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateHostDevice, queryKeys } from "@/lib/queryKeys";
import { notifyError, toast } from "@/lib/toast";

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
// local forest's registry keys refresh, and the toast says whether the
// uncommitted changes made it (null skips the toast). Shared with the
// mirror start, which lands the same way.
export function reportLanded(
  queryClient: QueryClient,
  localProjectId: string,
  result: Pick<SyncPullWorktreeResult, "captured" | "dirtyApplied">,
  headline: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.worktrees(localProjectId),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.branches(localProjectId),
  });
  if (headline === null) return;
  if (result.dirtyApplied || !result.captured) {
    toast.success(headline);
  } else {
    notifyError(
      `${headline}, without its uncommitted changes`,
      "They could not be applied and are still on the other device.",
    );
  }
}

export function useBringWorktreeHere({
  worktree,
  sourceProjectId,
  sourceIdentity,
  localProjectId,
  quiet = false,
}: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
  // Suppresses the toasts for a caller that reports the outcome itself
  // (the transplant dialog's done state), so the conclusion is told
  // once. The invalidations still run: they are about the cache, not
  // about who speaks.
  quiet?: boolean;
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
    onSuccess: (result) =>
      reportLanded(
        queryClient,
        localProjectId,
        result,
        quiet ? null : `Brought ${worktree.branch} here`,
      ),
    onError: (err) => {
      if (!quiet && !isCommandRefusedError(err)) {
        notifyError("Couldn't bring worktree here", err);
      }
    },
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
