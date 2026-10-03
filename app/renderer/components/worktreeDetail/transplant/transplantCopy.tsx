// The transplant dialog's words: its steps, its titles by stage, the
// line under the title, and the words around the flow's review. Apart
// from the dialog (TransplantDialog.tsx) so a picture of it
// (lab/scenes) says the same.
import type { FlowStage } from "../flow/PullFlowFrameView";
import type { Landing } from "../flow/pullSteps";

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

// The transplant's words around the flow's review.
export const TRANSPLANT_REVIEW = {
  heading: "Destination",
  sourceNote: "where it is now",
  startLabel: "Start transplant",
  idleNote: (sourceDeviceLabel: string) =>
    `Nothing on ${sourceDeviceLabel} is deleted until you say so at the last step.`,
};
