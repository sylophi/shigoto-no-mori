// What the transplant and the mirror dialogs have in common, which is
// everything but their words and the bodies of their first and last
// steps. Both are a
// pull-shaped mutation walked through the same three-step frame:
// review, the pull with its progress frames, and a last step that
// reports. The mutation's own status is the stage.
import { useState, type ReactNode } from "react";
import { Check, Loader2, X, type LucideIcon } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import { ModalShell } from "@/components/ui/modal-shell";
import { TONE_PILL } from "@/components/ui/status-dot";
import type { LandingChoice } from "@/hooks/remote/useMoveWorktree";
import { usePullProgress } from "@/hooks/remote/usePullProgress";
import { localDeviceId } from "@/lib/queryKeys";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useLandingTarget } from "./cloneDestination";
import { FlowHeader, StepRail } from "./FlowChrome";
import { usePullChoice } from "./ignoreChoice";
import { PullProgress, type PullProgressProps } from "./PullProgress";
import type { DestinationPick } from "./PullReview";
import { type Landing, useClock } from "./pullSteps";

export type FlowStage = "review" | "running" | "failed" | "done";

const STAGE_STEP: Record<FlowStage, number> = {
  review: 0,
  running: 1,
  failed: 1,
  done: 2,
};

// The tints are the flow's, so the two dialogs read as one family. A
// dialog brings its own review icon and its four titles.
const STAGE_LOOK: Record<
  Exclude<FlowStage, "review">,
  { tint: string; icon: LucideIcon; spin: boolean }
> = {
  running: { tint: TONE_PILL.sky, icon: Loader2, spin: true },
  failed: { tint: TONE_PILL.rose, icon: X, spin: false },
  done: { tint: TONE_PILL.emerald, icon: Check, spin: false },
};

type Landed = { worktree: { projectId: string; id: string } };

export function usePullFlow<Data extends Landed>({
  mutation,
  worktree,
  project,
  sourceIdentity,
  localProject,
  toPeer,
  onClose,
}: {
  mutation: UseMutationResult<Data, Error, LandingChoice>;
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
  const stage: FlowStage = mutation.isPending
    ? "running"
    : mutation.isError
      ? "failed"
      : mutation.isSuccess
        ? "done"
        : "review";
  // The attempt's clock: the mutation's own submit time, frozen at the
  // moment it settles.
  const [endedAt, setEndedAt] = useState(0);
  const now = useClock(stage === "running");
  const progress = usePullProgress(worktree.id);

  const start = () => {
    progress.reset();
    mutation.mutate(choice, { onSettled: () => setEndedAt(Date.now()) });
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
      // the flow with no report and no way back to the last step.
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
      {(stage === "running" || stage === "failed") && target && (
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
          onClose={onClose}
          onRetry={flow.start}
          {...progressExtras}
        />
      )}
    </ModalShell>
  );
}
