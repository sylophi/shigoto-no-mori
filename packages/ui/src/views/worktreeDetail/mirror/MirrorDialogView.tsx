// The mirror flow's own words and its last step, drawn: the dialog's
// headline at each stage, and the live copy (MirrorDialog.tsx binds
// them).
import type { ReactNode } from "react";
import { Button } from "../../../primitives/button.tsx";
import { Chip } from "../../../primitives/chip-button.tsx";
import { SectionHeading } from "../../../primitives/section-heading.tsx";
import { type StatusTone, StatusDot } from "../../../primitives/status-dot.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import { cn } from "../../../lib/utils.ts";
import { CARD, FlowBodyView, FlowFooterView } from "../flow/FlowChromeView.tsx";
import type { FlowStage } from "../flow/pullSteps.ts";

// A primary checkout's copy lands on a branch of its own
// (contracts' git/branches.ts), which the words say when the two differ.
export function MirrorHeadlineView({
  stage,
  branch,
  landingBranch,
  sourceDeviceLabel,
  on,
  running,
}: {
  stage: FlowStage;
  branch: string;
  landingBranch: string;
  sourceDeviceLabel: string;
  // Where the copy lands, in words ("here", "on the Thinkpad").
  on: string;
  // The running stage's line, off the progress frames.
  running: string;
}) {
  const renamed = landingBranch !== branch;
  return (
    <>
      {stage === "review" &&
        (renamed ? (
          <>
            A live copy of {sourceDeviceLabel}'s primary checkout {on}, on{" "}
            <span className="font-mono">{landingBranch}</span>, kept in step
            with its <span className="font-mono">{branch}</span>.
          </>
        ) : (
          <>
            A live copy of <span className="font-mono">{branch}</span> {on},
            kept in step with {sourceDeviceLabel}.
          </>
        ))}
      {stage === "running" && running}
      {stage === "failed" && `Nothing on ${sourceDeviceLabel} changed.`}
      {stage === "cancelled" &&
        `Stopped before the mirror opened. Nothing on ${sourceDeviceLabel} changed.`}
      {stage === "done" &&
        (renamed ? (
          <>
            <span className="font-mono">{landingBranch}</span> {on} follows{" "}
            {sourceDeviceLabel}'s <span className="font-mono">{branch}</span>{" "}
            and stays in step.
          </>
        ) : (
          <>
            <span className="font-mono">{branch}</span> is on both devices and
            stays in step.
          </>
        ))}
    </>
  );
}

// Step 3: the copy has landed and the session is up.
export function MirrorLiveView({
  branch,
  path,
  status,
  summary,
  sourceDeviceLabel,
  thisDeviceLabel,
  dirtyApplied,
  onDone,
}: {
  branch: string;
  // Where the copy landed (LandedPath).
  path: ReactNode;
  // The session's status, null until it is in hand.
  status: { tone: StatusTone; label: string } | null;
  summary: string | null;
  sourceDeviceLabel: string;
  // The device holding the copy, and the words for that.
  thisDeviceLabel: string;
  dirtyApplied: boolean;
  onDone: () => void;
}) {
  return (
    <>
      <FlowBodyView>
        <section className="space-y-2">
          <SectionHeading>Copy on {thisDeviceLabel}</SectionHeading>
          <div className={cn(CARD, "space-y-1.5")}>
            <SimpleTooltip whenTruncated tip={branch}>
              <p className="truncate font-mono text-sm font-semibold">
                {branch}
              </p>
            </SimpleTooltip>
            {path}
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <Chip>
                <StatusDot
                  tone={status?.tone ?? "sky"}
                  label={status?.label ?? "Opening"}
                />
              </Chip>
              {summary !== null && <Chip>{summary}</Chip>}
              {!dirtyApplied && (
                <Chip className="text-amber-700 dark:text-amber-300">
                  Uncommitted changes stayed on {sourceDeviceLabel}
                </Chip>
              )}
            </div>
          </div>
        </section>
      </FlowBodyView>
      {/* One way out, to this device's half of the pair (finish). */}
      <FlowFooterView>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </FlowFooterView>
    </>
  );
}
