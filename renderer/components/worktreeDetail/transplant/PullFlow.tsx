// What the transplant and the mirror dialogs have in common, which is
// everything but their words and their three bodies. Both are a
// pull-shaped mutation walked through the same three-step frame:
// review, the pull with its progress frames, and a last step that
// reports. The mutation's own status is the stage.
import { useState, type ReactNode } from "react";
import { Check, Loader2, X, type LucideIcon } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import { ModalShell } from "@/components/ui/modal-shell";
import { TONE_PILL } from "@/components/ui/status-dot";
import type { PullChoice } from "@/hooks/remote/useMirrors";
import { usePullProgress } from "@/hooks/remote/usePullProgress";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { FlowHeader, StepRail } from "./TransplantChrome";
import { useClock } from "./transplantSteps";

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
  { tint: string; icon: LucideIcon; spin?: boolean }
> = {
  running: { tint: TONE_PILL.sky, icon: Loader2, spin: true },
  failed: { tint: TONE_PILL.rose, icon: X },
  done: { tint: TONE_PILL.emerald, icon: Check },
};

type Landed = { worktree: { projectId: string; id: string } };

export function usePullFlow<Data extends Landed>({
  mutation,
  sourceWorktreeId,
  choice,
  onClose,
}: {
  mutation: UseMutationResult<Data, Error, PullChoice>;
  sourceWorktreeId: string;
  choice: PullChoice;
  onClose: () => void;
}) {
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
  const progress = usePullProgress(sourceWorktreeId);

  const start = () => {
    progress.reset();
    mutation.mutate(choice, { onSettled: () => setEndedAt(Date.now()) });
  };

  const open = () => {
    if (!mutation.data) return;
    onClose();
    // The landed worktree is local, so leave the remote scope behind
    // explicitly rather than through the scoped nav.
    nav.toLocalWorktree(
      mutation.data.worktree.projectId,
      mutation.data.worktree.id,
    );
  };

  return {
    stage,
    elapsed: (stage === "running" ? now : endedAt) - mutation.submittedAt,
    progress,
    start,
    open,
  };
}

export function PullFlowFrame({
  stage,
  elapsed,
  reviewIcon,
  titles,
  thisDeviceLabel,
  steps,
  stepsLabel,
  headline,
  onClose,
  children,
}: {
  stage: FlowStage;
  elapsed: number;
  reviewIcon: LucideIcon;
  titles: Record<FlowStage, string>;
  thisDeviceLabel: string;
  // Omitted for the transplant, whose names are the rail's defaults.
  steps?: readonly string[];
  stepsLabel?: string;
  // The line under the title, the dialog's own words for this stage.
  headline: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const look =
    stage === "review"
      ? { tint: "bg-accent text-accent-foreground", icon: reviewIcon }
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
        spin={"spin" in look ? look.spin : undefined}
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
    </ModalShell>
  );
}
