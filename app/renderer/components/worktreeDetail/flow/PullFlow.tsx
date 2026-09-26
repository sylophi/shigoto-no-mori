// What the transplant and the mirror dialogs have in common, which is
// everything but their words and the bodies of their first and last
// steps. Both are a
// pull-shaped mutation walked through the same three-step frame:
// review, the pull with its progress frames, and a last step that
// reports. The mutation's own status is the stage, with one reading
// on top: a mutation that failed because the user cancelled it is the
// cancelled stage, not a failure.
import { useState, type ReactNode } from "react";
import { Ban, Check, Loader2, X, type LucideIcon } from "lucide-react";
import { isMoveCancelledError } from "@shared/ipc/modules/sync";
import type { Project, Worktree } from "@shared/schemas";
import { ModalShell } from "@/components/ui/modal-shell";
import { TONE_PILL } from "@/components/ui/status-dot";
import type { MoveMutation } from "@/hooks/remote/useMoveWorktree";
import { usePullProgress } from "@/hooks/remote/usePullProgress";
import { localDeviceId } from "@/lib/queryKeys";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useLandingTarget } from "./cloneDestination";
import { FlowHeader, StepRail } from "./FlowChrome";
import { usePullChoice } from "./ignoreChoice";
import { PullProgress, type PullProgressProps } from "./PullProgress";
import type { DestinationPick } from "./PullReview";
import { type Landing, useClock } from "./pullSteps";

export type FlowStage = "review" | "running" | "failed" | "cancelled" | "done";

const STAGE_STEP: Record<FlowStage, number> = {
  review: 0,
  running: 1,
  failed: 1,
  cancelled: 1,
  done: 2,
};

// The tints are the flow's, so the two dialogs read as one family. A
// dialog brings its own review icon and its five titles.
const STAGE_LOOK: Record<
  Exclude<FlowStage, "review">,
  { tint: string; icon: LucideIcon; spin: boolean }
> = {
  running: { tint: TONE_PILL.sky, icon: Loader2, spin: true },
  failed: { tint: TONE_PILL.rose, icon: X, spin: false },
  cancelled: { tint: TONE_PILL.amber, icon: Ban, spin: false },
  done: { tint: TONE_PILL.emerald, icon: Check, spin: false },
};

type Landed = { worktree: { projectId: string; id: string } };

// The mutation's own status as the stage, a failure the user asked for
// told apart from one they did not.
function stageOf(mutation: MoveMutation<unknown>): FlowStage {
  if (mutation.isPending) return "running";
  if (mutation.isSuccess) return "done";
  if (!mutation.isError) return "review";
  return isMoveCancelledError(mutation.error) ? "cancelled" : "failed";
}

export function usePullFlow<Data extends Landed>({
  mutation,
  worktree,
  project,
  sourceIdentity,
  localProject,
  toPeer,
  onClose,
}: {
  mutation: MoveMutation<Data>;
  // The source pair, on the device the dialog is scoped to.
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  // The landing side's project (flow/PullReview.tsx says why), absent
  // before a flow to a peer has its pick or when the start clones.
  localProject: Project | undefined;
  // A flow to a peer: the pick of which peer.
  toPeer: DestinationPick | undefined;
  onClose: () => void;
}) {
  // The leave-out rule and the setup switch. Under the source scope:
  // its ignored list walks the checkout over the device link.
  const pull = usePullChoice(project.id, worktree.id, sourceIdentity);
  const target = useLandingTarget({
    localProject,
    sourceProject: project,
    unpicked: toPeer !== undefined && toPeer.pickedId === null,
    submitted: mutation.variables,
  });
  // The key only when there is a clone, which the run then reads back
  // off what it was submitted with (useLandingTarget).
  const choice = target?.clone
    ? { ...pull.choice, cloneInto: target.clone.cloneInto }
    : pull.choice;
  // Where the worktree lands: this machine, unless the flow is a
  // transplant to a peer.
  const destinationDeviceId = toPeer?.pickedId ?? localDeviceId;
  const nav = useWorktreeNav();
  const stage = stageOf(mutation);
  // The attempt's clock: the mutation's own submit time, frozen at the
  // moment it settles.
  const [endedAt, setEndedAt] = useState(0);
  // The cancel asked for and not yet answered by the mutation settling:
  // the running view says so and takes no second cancel.
  const [cancelling, setCancelling] = useState(false);
  const now = useClock(stage === "running");
  const progress = usePullProgress(worktree.id);

  const start = () => {
    progress.reset();
    setCancelling(false);
    mutation.mutate(choice, {
      onSettled: () => {
        setEndedAt(Date.now());
        setCancelling(false);
      },
    });
  };

  // The cancel is asked of the device running the move and the
  // mutation settles on its own account, cancelled or (a cancel that
  // came too late) done. A cancel that finds nothing to cancel is one
  // the settle beat, so the mark comes off again: the settle may have
  // cleared it already, or be a moment away.
  const cancel = () => {
    setCancelling(true);
    mutation.cancel().then(
      (found) => {
        if (!found) setCancelling(false);
      },
      () => setCancelling(false),
    );
  };

  const open = () => {
    if (!mutation.data) return;
    onClose();
    // The landed worktree is on the destination, not in the scope the
    // dialog opened under, so the tree is named explicitly rather than
    // left to the scoped nav.
    const { projectId, id } = mutation.data.worktree;
    nav.toDeviceWorktree(destinationDeviceId, projectId, id);
  };

  return {
    stage,
    elapsed: (stage === "running" ? now : endedAt) - mutation.submittedAt,
    progress,
    start,
    cancel,
    cancelling,
    open,
    pull,
    target,
    error: mutation.error,
  };
}

export type PullFlowState = ReturnType<typeof usePullFlow>;

// What a dialog adds to the running and failed view's shared props:
// its extra rows and its own words (PullProgress.tsx).
type ProgressExtras = Pick<
  PullProgressProps,
  | "extraRows"
  | "filesDetail"
  | "sourcePart"
  | "runningNote"
  | "failedNote"
  | "cancelledNote"
  | "progressLabel"
>;

export function PullFlowFrame({
  flow,
  worktree,
  reviewIcon,
  titles,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing,
  steps,
  stepsLabel,
  headline,
  progressExtras,
  onClose,
  children,
}: {
  flow: PullFlowState;
  worktree: Worktree;
  reviewIcon: LucideIcon;
  titles: Record<FlowStage, string>;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  landing: Landing;
  steps: readonly string[];
  stepsLabel: string;
  // The line under the title, the dialog's own words for this stage.
  headline: ReactNode;
  progressExtras: ProgressExtras;
  onClose: () => void;
  // The review and the last step. The frame draws the pull between.
  children: ReactNode;
}) {
  const { stage, elapsed, progress, target } = flow;
  const look =
    stage === "review"
      ? {
          tint: "bg-accent text-accent-foreground",
          icon: reviewIcon,
          spin: false,
        }
      : STAGE_LOOK[stage];
  const running = stage === "running";
  return (
    <ModalShell
      // While the pull runs neither Escape nor the backdrop may close
      // the dialog: the mutation is quiet, so dismissing it would end
      // the flow with no report and no way back to the last step. The
      // way out is the running view's Cancel, which ends the move.
      onClose={running ? () => {} : onClose}
      closeOnEscape={!running}
      popoverClassName="flex max-h-[85vh] max-w-4xl flex-col"
    >
      <FlowHeader
        tint={look.tint}
        icon={look.icon}
        spin={look.spin}
        title={`${titles[stage]}${running ? ` to ${thisDeviceLabel}` : ""}`}
        elapsed={
          stage === "review"
            ? undefined
            : { ms: elapsed, label: running ? "elapsed" : "total" }
        }
        onClose={onClose}
      >
        {headline}
      </FlowHeader>
      <StepRail current={STAGE_STEP[stage]} steps={steps} label={stepsLabel} />
      {children}
      {STAGE_STEP[stage] === 1 && target && (
        <PullProgress
          frame={progress.frame}
          phasesSeen={progress.phasesSeen}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          worktree={worktree}
          target={target}
          runSetup={flow.pull.runSetup}
          landing={landing}
          error={stage === "failed" ? flow.error : undefined}
          cancelled={stage === "cancelled"}
          cancelling={flow.cancelling}
          onCancel={flow.cancel}
          onClose={onClose}
          onRetry={flow.start}
          {...progressExtras}
        />
      )}
    </ModalShell>
  );
}
