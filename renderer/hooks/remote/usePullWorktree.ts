// The pull: a peer's worktree lands on this machine. The transplant
// dialog drives it directly and the mirror start runs it under its
// own orchestration. Capture, transfer, create, and dirty apply ride a
// single pending state. The pull's running commentary streams
// separately (usePullProgress). The handler re-verifies the identity
// match, so the gate at the call sites is UX, not the wall. Refusals
// surface centrally, and the outcome is the caller's to report: the
// dialog's last step is the report, and the mirror lands through
// reportLanded below. The send is the same landing the other way: one
// of this device's worktrees, landed on a peer.
import { pullWorktreeName } from "@shared/git/branches";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { MirrorStartPayload } from "@shared/ipc/modules/mirror";
import type {
  SyncPullWorktreeResult,
  SyncTeardownSourceResult,
} from "@shared/ipc/modules/sync";
import { isScriptsRunningReason } from "@shared/errors";
import type { MirrorIgnoreChoice } from "@shared/leaveOutRule";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateHostDevice, queryKeys } from "@/lib/queryKeys";

// The teardown reports a kept source with its raw reason. Scripts
// still running is the one worth spelling out, and every surface that
// reports a kept source says it from here. Phrased for mid-sentence
// use, which is where both callers put it.
export function keptSourceReason({
  sourceError,
  sourceErrorTag,
}: Pick<SyncTeardownSourceResult, "sourceError" | "sourceErrorTag">):
  | string
  | undefined {
  return sourceError !== undefined &&
    isScriptsRunningReason(sourceError, sourceErrorTag)
    ? "scripts are still running there."
    : sourceError;
}

// What every pull-shaped landing does once the worktree is here: the
// local forest's registry keys refresh. The outcome is the caller's
// to report (the dialogs' last step is the report). Shared with the
// mirror start, which lands the same way.
function invalidateLanded(
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

// Where a pull-shaped landing comes from and where it lands.
export type PullSource = {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
};

// What a mirror leaves out, as the dialog and the section hand it to
// the host: the rule plus the engine patterns it resolved to.
export type { MirrorIgnoreChoice };

// What a pull dialog hands its mutation: the rule plus the setup
// switch, the same for a transplant and a mirror start.
export type PullChoice = MirrorIgnoreChoice & { runSetup: boolean };

// The mutation the pull and the mirror start share: the same payload
// built from the scope and the source (the mirror start's, which is the
// pull's with the leave-out rule a PullChoice always carries), handed
// to whichever verb lands it. The leave-out rule rides along (the host brings the ignored files
// it admits over once the worktree is here). Success only invalidates:
// the caller shows the outcome, so the conclusion is told once.
export function useLandingMutation<Result>(
  { worktree, sourceProjectId, sourceIdentity, localProjectId }: PullSource,
  land: (payload: MirrorStartPayload) => Promise<Result>,
) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (choice: PullChoice) =>
      land({
        sourceDeviceId: deviceId,
        sourceProjectId,
        sourceWorktreeId: worktree.id,
        sourceIdentity,
        branch: worktree.branch,
        worktreeName: pullWorktreeName(worktree),
        ...choice,
      }),
    onSuccess: () => invalidateLanded(queryClient, localProjectId),
    meta: { silentError: true },
  });
}

export function usePullWorktree(source: PullSource) {
  return useLandingMutation(
    source,
    (payload): Promise<SyncPullWorktreeResult> =>
      window.api.sync.pullWorktree(payload),
  );
}

// The landing the other way: one of this device's worktrees, landed on
// a peer by a local verb (the send, or the mirror start built on it).
// What lands is on the target, so its cached view is what refreshes.
// The target is absent until the dialog's destination is picked, which
// its Start waits on, so the refusal here is a guard and not a path.
const UNPICKED = "Pick the device it goes to first.";

export function useLandingOnPeer<Result>(
  targetDeviceId: string | undefined,
  land: (targetDeviceId: string, choice: PullChoice) => Promise<Result>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (choice: PullChoice) => {
      if (targetDeviceId === undefined) throw new Error(UNPICKED);
      const result = await land(targetDeviceId, choice);
      invalidateHostDevice(queryClient, targetDeviceId);
      return result;
    },
    meta: { silentError: true },
  });
}

export function useSendWorktree(
  worktree: Worktree,
  targetDeviceId: string | undefined,
) {
  return useLandingOnPeer(
    targetDeviceId,
    (target, choice): Promise<SyncPullWorktreeResult> =>
      window.api.sync.sendWorktree({
        targetDeviceId: target,
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        ...choice,
      }),
  );
}

// The sent worktree's teardown: what it removes is here, so the local
// forest's keys are what refresh.
export function useTeardownSent(
  worktree: Worktree,
  targetDeviceId: string | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (targetDeviceId === undefined) throw new Error(UNPICKED);
      return window.api.sync.teardownSent({
        targetDeviceId,
        projectId: worktree.projectId,
        worktreeId: worktree.id,
      });
    },
    onSuccess: () => invalidateLanded(queryClient, worktree.projectId),
    meta: { errorTitle: "Couldn't tear down the source worktree" },
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
