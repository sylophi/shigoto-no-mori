// The pull dialogs' frame as a plain view (PullFlow.tsx walks it
// through a run): the header in the stage's tint and words, the step
// rail, and the stage's body under them. The shell around it is the
// caller's, ModalShell live and ModalShellView in a scene.
import type { ReactNode } from "react";
import { Ban, Check, Loader2, X, type LucideIcon } from "lucide-react";
import { TONE_PILL } from "@/components/ui/status-dot";
import { FlowHeader, StepRail } from "./FlowChromeView";

export type FlowStage = "review" | "running" | "failed" | "cancelled" | "done";

// The dialog box's width, the live shell's and a scene's alike.
export const PULL_FLOW_POPOVER = "max-w-4xl";

export const STAGE_STEP: Record<FlowStage, number> = {
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

export function PullFlowFrameView({
  stage,
  reviewIcon,
  titles,
  thisDeviceLabel,
  elapsed,
  steps,
  stepsLabel,
  headline,
  onClose,
  children,
}: {
  stage: FlowStage;
  reviewIcon: LucideIcon;
  titles: Record<FlowStage, string>;
  thisDeviceLabel: string;
  // The attempt's clock in ms, shown once it runs.
  elapsed: number;
  steps: readonly string[];
  stepsLabel: string;
  // The line under the title, the dialog's own words for this stage.
  headline: ReactNode;
  onClose: () => void;
  // The stage's body.
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
  const running = stage === "running";
  return (
    <>
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
    </>
  );
}
