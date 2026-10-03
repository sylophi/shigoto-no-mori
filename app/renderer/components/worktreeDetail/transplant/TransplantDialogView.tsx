// The transplant dialog at its review step as one plain view: the
// frame (header, step rail) and the review, in the dialog's box. The
// live dialog (TransplantDialog.tsx) walks the same frame through the
// run with ModalShell around it, and a scene (lab/scenes) draws this
// from the lab's fixtures. The box alone by default, or over a
// picture of the window when a backdrop is handed in.
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  ModalShellBox,
  ModalShellView,
} from "@/components/ui/modal-shell-view";
import {
  type FlowStage,
  PULL_FLOW_POPOVER,
  PullFlowFrameView,
} from "../flow/PullFlowFrameView";
import type { Landing } from "../flow/pullSteps";
import {
  TransplantReviewView,
  type TransplantReviewViewProps,
} from "./TransplantReviewView";

export const TRANSPLANT_STEPS = [
  "Review & destination",
  "Transplant",
  "Finish up source",
] as const;

export const TRANSPLANT_TITLES: Record<FlowStage, string> = {
  review: "Transplant worktree",
  running: "Transplanting",
  failed: "Transplant stopped",
  cancelled: "Transplant cancelled",
  done: "Transplant complete",
};

export const TRANSPLANT_STEPS_LABEL = "Transplant steps";

// The line under the title while the review is up.
export function TransplantReviewHeadline({
  branch,
  landing,
  sourceDeviceLabel,
}: {
  branch: string;
  landing: Landing;
  sourceDeviceLabel: string;
}) {
  return (
    <>
      Move <span className="font-mono">{branch}</span>{" "}
      {landing.onPeer ? landing.to : `off ${sourceDeviceLabel}`}, uncommitted
      work included.
    </>
  );
}

const noop = () => {};

export function TransplantDialogView({
  landing,
  backdrop,
  onClose = noop,
  ...review
}: TransplantReviewViewProps & {
  landing: Landing;
  // The window the dialog sits over. Given, the dialog is drawn over
  // it as the live one is (ModalShellView, contained in the caller's
  // box). Absent, the box alone.
  backdrop?: ReactNode;
  onClose?: () => void;
}) {
  const dialog = (
    <PullFlowFrameView
      stage="review"
      reviewIcon={ArrowRight}
      titles={TRANSPLANT_TITLES}
      thisDeviceLabel={review.thisDeviceLabel}
      elapsed={0}
      steps={TRANSPLANT_STEPS}
      stepsLabel={TRANSPLANT_STEPS_LABEL}
      headline={
        <TransplantReviewHeadline
          branch={review.worktree.branch}
          landing={landing}
          sourceDeviceLabel={review.sourceDeviceLabel}
        />
      }
      onClose={onClose}
    >
      <TransplantReviewView onCancel={onClose} {...review} />
    </PullFlowFrameView>
  );
  if (backdrop === undefined) {
    return (
      <ModalShellBox popoverClassName={PULL_FLOW_POPOVER}>
        {dialog}
      </ModalShellBox>
    );
  }
  return (
    <div className="relative">
      {backdrop}
      <ModalShellView contained popoverClassName={PULL_FLOW_POPOVER}>
        {dialog}
      </ModalShellView>
    </div>
  );
}
