// The flow dialogs' frame, drawn (PullFlow.tsx PullFlowFrame binds it
// and puts it in a ModalShell): the head in the stage's look, the
// dialog's own words under its title, the step rail, and the step.
import type { ReactNode } from "react";
import { Ban, Check, Loader2, X, type LucideIcon } from "lucide-react";
import { TONE_PILL } from "@/components/ui/status-dot";
import { FlowHeaderView, StepRailView } from "./FlowChromeView";
import type { FlowStage } from "./pullSteps";

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

// The rail's step a stage sits on: the review, the pull, the last.
export function stageStep(stage: FlowStage): number {
  return STAGE_STEP[stage];
}

export function PullFlowFrameView({
  stage,
  reviewIcon,
  title,
  elapsed,
  headline,
  steps,
  stepsLabel,
  onClose,
  children,
}: {
  stage: FlowStage;
  reviewIcon: LucideIcon;
  title: string;
  // How long the pull has run, in ms.
  elapsed: number;
  // The line under the title, the dialog's own words for this stage.
  headline: ReactNode;
  steps: readonly string[];
  stepsLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const look =
    stage === "review"
      ? {
          tint: "bg-accent text-accent-foreground",
          icon: reviewIcon,
          spin: false,
        }
      : STAGE_LOOK[stage];
  return (
    <>
      <FlowHeaderView
        tint={look.tint}
        icon={look.icon}
        spin={look.spin}
        title={title}
        elapsed={
          stage === "review"
            ? undefined
            : {
                ms: elapsed,
                label: stage === "running" ? "elapsed" : "total",
              }
        }
        onClose={onClose}
      >
        {headline}
      </FlowHeaderView>
      <StepRailView
        current={STAGE_STEP[stage]}
        steps={steps}
        label={stepsLabel}
      />
      {children}
    </>
  );
}
