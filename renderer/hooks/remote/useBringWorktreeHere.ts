// The one bring-a-peer's-worktree-here mutation (pull: v2 step 7 slice
// C, transplant: step 9), shared by the remote forest's row controls
// and the remote worktree detail's footer: capture, transfer, create,
// and dirty apply ride a single pending state -- create-phase progress
// streams to the local worktree's own detail page, not the calling
// surface. The handler re-verifies the identity match; the gate at the
// call sites is UX, not the wall. Refusals surface centrally,
// everything else toasts here: the result lands on another page (the
// local forest), so the toast is usually the only visible conclusion --
// a caller that shows the outcome itself passes `quiet`.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type {
  SyncPullWorktreeResult,
  SyncTransplantWorktreeResult,
} from "@shared/ipc/modules/sync";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError, toast } from "@/lib/toast";

// The handler reports a kept source with its raw reason. scripts-running
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

export function useBringWorktreeHere({
  worktree,
  sourceProjectId,
  sourceIdentity,
  localProjectId,
  transplant,
  quiet = false,
}: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
  transplant: boolean;
  // Suppresses the toasts for a caller that reports the outcome itself
  // (the transplant dialog's done state), so the conclusion is told
  // once. The invalidations still run: they are about the cache, not
  // about who speaks.
  quiet?: boolean;
}) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    // The explicit union return type keeps the transplant-only fields
    // narrowable via "sourceRemoved" in result below.
    mutationFn: (): Promise<
      SyncPullWorktreeResult | SyncTransplantWorktreeResult
    > => {
      const payload = {
        sourceDeviceId: deviceId,
        sourceProjectId,
        sourceWorktreeId: worktree.id,
        sourceIdentity,
        branch: worktree.branch,
      };
      return transplant
        ? window.api.sync.transplantWorktree(payload)
        : window.api.sync.pullWorktree(payload);
    },
    onSuccess: (result) => {
      // The new worktree and branch are LOCAL, so this invalidates the
      // local device's registry (module-level queryKeys), never the
      // surrounding remote scope's. On a transplant the source side
      // refreshes off the host's own resolved-mutation ping
      // (useWatchRemoteHost).
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktrees(localProjectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.branches(localProjectId),
      });
      if (quiet) return;
      if ("sourceRemoved" in result) {
        // Transplant: a refused or failed teardown (including a dirty
        // state that did not land here) is a partial success the
        // handler reports via sourceRemoved/sourceError instead of
        // throwing, so it lands in onSuccess with its own voice.
        if (result.sourceRemoved) {
          toast.success(`Transplanted ${worktree.branch} here`);
        } else {
          notifyError(
            `Brought ${worktree.branch} here, but the source worktree stayed`,
            keptSourceReason(result.sourceError),
          );
        }
        return;
      }
      // Pull: an unapplied capture is a partial success, the worktree
      // is real and the uncommitted changes stayed safe on the source.
      if (result.dirtyApplied || !result.captured) {
        toast.success(`Brought ${worktree.branch} here`);
      } else {
        notifyError(
          `Brought ${worktree.branch} here, without its uncommitted changes`,
          "They could not be applied and are still on the other device.",
        );
      }
    },
    onError: (err) => {
      if (!quiet && !isCommandRefusedError(err)) {
        notifyError(
          transplant
            ? "Couldn't transplant worktree"
            : "Couldn't bring worktree here",
          err,
        );
      }
    },
    meta: { silentError: true },
  });
}
