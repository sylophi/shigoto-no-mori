import type { FlowStage } from "../flow/pullSteps.ts";

// The transplant dialog's headline at each stage.
export function TransplantHeadlineView({
  stage,
  branch,
  sourceDeviceLabel,
  thisDeviceLabel,
  away,
  running,
}: {
  stage: FlowStage;
  branch: string;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  // Where the move takes it, in words ("to the Thinkpad", "off the
  // MacBook").
  away: string;
  // The running stage's line, off the progress frames.
  running: string;
}) {
  return (
    <>
      {stage === "review" && (
        <>
          Move <span className="font-mono">{branch}</span> {away}, uncommitted
          work included.
        </>
      )}
      {stage === "running" && running}
      {stage === "failed" && `Nothing on ${sourceDeviceLabel} changed.`}
      {stage === "cancelled" &&
        `Stopped where you asked. Nothing on ${sourceDeviceLabel} changed.`}
      {stage === "done" && (
        <>
          <span className="font-mono">{branch}</span> now lives on{" "}
          {thisDeviceLabel}. What about the copy on {sourceDeviceLabel}?
        </>
      )}
    </>
  );
}
