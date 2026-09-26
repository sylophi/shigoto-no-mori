// A move: a worktree landing on another device, the transplant's and
// the mirror start's shared mutation. It runs both ways: a pull brings
// a peer's worktree here, a send takes one of this device's to a peer,
// and the host lands it the same way either way round (the landing
// runs on the destination). A mirror's "pull" is the peer's send
// towards this device, since the original's device runs every mirror. Capture, transfer, create, and dirty apply
// ride a single pending state. The move's running commentary streams
// separately (usePullProgress). The host re-verifies the identity
// match, so the gate at the call sites is UX, not the wall. Refusals
// surface centrally, and the outcome is the caller's to report: the
// dialog's last step is the report.
import { pullWorktreeName } from "@shared/git/branches";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { z } from "zod";
import type { MirrorStartToPayload } from "@shared/ipc/modules/mirror";
import type {
  SyncCloneInto,
  SyncPullWorktreePayloadSchema,
  SyncPullWorktreeResult,
} from "@shared/ipc/modules/sync";
import type { MirrorIgnoreChoice } from "@shared/leaveOutRule";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { invalidateHostDevice, queryKeys } from "@/lib/queryKeys";
import { quietVillagerMoves } from "@/lib/villagers/moves";

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

// What a pull does once the worktree is here: the local forest's
// registry keys refresh, read off the landed worktree (the project it
// went into may be one the pull made). Also what a send's teardown
// refreshes, the removed source being this device's.
function invalidateLanded(queryClient: QueryClient, landed: Landed): void {
  if (landed.cloned !== undefined) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
  }
  void queryClient.invalidateQueries({
    queryKey: queryKeys.worktrees(landed.worktree.projectId),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.branches(landed.worktree.projectId),
  });
}

// Where a pull comes from: the dialog's scope is the peer holding it.
// Where it lands is this machine's checkout of the same repo, which
// the host resolves.
export type PullSource = {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
};

// Which move: a pull of a peer's worktree, or a send of one of this
// device's. A send's destination is absent until the dialog's pick,
// which its Start waits on, so the refusal below is a guard and not a
// path.
export type Move =
  | { direction: "pull"; source: PullSource }
  | {
      direction: "send";
      worktree: Worktree;
      targetDeviceId: string | undefined;
    };
const UNPICKED = "Pick the device it goes to first.";

// A move tells of the worktree arriving itself, so its villager's moves
// (in on the landing side, out on a teardown) stay untold.
function quietMove(move: Move): void {
  const worktree =
    move.direction === "pull" ? move.source.worktree : move.worktree;
  const landed = pullWorktreeName(worktree);
  quietVillagerMoves(
    landed === undefined ? [worktree.name] : [worktree.name, landed],
  );
}

// What a mirror leaves out, as the dialog and the section hand it to
// the host: the rule plus the engine patterns it resolved to.
export type { MirrorIgnoreChoice };

// What a dialog hands its mutation: the rule plus the setup switch,
// the same for a transplant and a mirror start.
export type PullChoice = MirrorIgnoreChoice & { runSetup: boolean };

// And where to clone the repo first when the destination has no
// checkout of it (the review's clone section), either way round.
export type LandingChoice = PullChoice & { cloneInto?: SyncCloneInto };

type Landed = Pick<SyncPullWorktreeResult, "worktree" | "cloned">;

// A pull as the mutation hands it over: the source named in the peer's
// terms, the dialog's choice riding along.
export type PullPayload = z.infer<typeof SyncPullWorktreePayloadSchema> &
  LandingChoice;

// The mutation every move shares, handed the verbs it lands through
// (the transplant's or the mirror start's): the payload built from the
// scope and the move, the dialog's choice riding along. Success only
// invalidates, the destination's view: this machine's forest for a
// pull (a mirror's too, which the source device runs but lands here),
// the peer's for a send. The caller shows the outcome, so the
// conclusion is told once.
export function useMoveMutation<Result extends Landed>(
  move: Move,
  land: {
    pull: (payload: PullPayload) => Promise<Result>;
    send: (payload: MirrorStartToPayload) => Promise<Result>;
  },
) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => quietMove(move),
    mutationFn: async (choice: LandingChoice) => {
      if (move.direction === "pull") {
        const { worktree, sourceProjectId, sourceIdentity } = move.source;
        const landed = await land.pull({
          sourceDeviceId: deviceId,
          sourceProjectId,
          sourceWorktreeId: worktree.id,
          sourceIdentity,
          branch: worktree.branch,
          worktreeName: pullWorktreeName(worktree),
          ...choice,
        });
        invalidateLanded(queryClient, landed);
        return landed;
      }
      const { worktree, targetDeviceId } = move;
      if (targetDeviceId === undefined) throw new Error(UNPICKED);
      const landed = await land.send({
        targetDeviceId,
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        ...choice,
      });
      invalidateHostDevice(queryClient, targetDeviceId);
      return landed;
    },
    meta: { silentError: true },
  });
}

// The transplant's move.
export function useMoveWorktree(move: Move) {
  return useMoveMutation(move, {
    pull: (payload): Promise<SyncPullWorktreeResult> =>
      window.api.sync.pullWorktree(payload),
    send: (payload): Promise<SyncPullWorktreeResult> =>
      window.api.sync.sendWorktree(payload),
  });
}

// The transplant's second half: tear the source worktree down once the
// move landed it, on the peer after a pull, here after a send. A
// refused or failed teardown is a partial success the handler returns
// instead of throwing (the worktree simply exists on both devices), so
// the caller reads sourceRemoved and speaks for it. Only a call that
// never got that far rejects. What it removed refreshes: the peer's
// whole cached view (the sweep its own resolved-mutation ping runs),
// or this machine's forest.
export function useTeardownSource(move: Move) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (move.direction === "pull") {
        return window.api.sync.teardownSource({
          direction: "pull",
          deviceId,
          projectId: move.source.sourceProjectId,
          worktreeId: move.source.worktree.id,
        });
      }
      if (move.targetDeviceId === undefined) throw new Error(UNPICKED);
      return window.api.sync.teardownSource({
        direction: "send",
        deviceId: move.targetDeviceId,
        projectId: move.worktree.projectId,
        worktreeId: move.worktree.id,
      });
    },
    onSuccess: () => {
      if (move.direction === "pull") {
        invalidateHostDevice(queryClient, deviceId);
      } else {
        invalidateLanded(queryClient, { worktree: move.worktree });
      }
    },
    meta: { errorTitle: "Couldn't tear down the source worktree" },
  });
}
