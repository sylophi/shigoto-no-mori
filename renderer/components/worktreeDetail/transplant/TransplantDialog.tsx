// The transplant flow, shaped after the owner's remote-ops mockups and
// honest to the backend: three steps on one rail. Review lists what
// travels and where it lands. Transplant is the pull with its progress
// frames read into four named steps. Finish up source shows the landed
// worktree and asks what happens to the copy on the source device
// (keep, shelve, or tear down). The move is the pull mutation: the
// last step is the report, and the mutation's own status is the
// stage.
import { ArrowRight } from "lucide-react";
import { pullBringsIgnoredFiles } from "@shared/ipc/modules/sync";
import type { Project, Worktree } from "@shared/schemas";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { usePullWorktree } from "@/hooks/remote/usePullWorktree";
import {
  modeOf,
  selectionSummary,
  usePullChoice,
} from "../mirror/ignoreChoice";
import { type FlowStage, PullFlowFrame, usePullFlow } from "./PullFlow";
import { TransplantFinish } from "./TransplantFinish";
import { TransplantProgress } from "./TransplantProgress";
import { TransplantReview } from "./TransplantReview";
import { stepHeadline } from "./transplantSteps";

const TITLES: Record<FlowStage, string> = {
  review: "Transplant worktree",
  running: "Transplanting",
  failed: "Transplant stopped",
  done: "Transplant complete",
};

export function TransplantDialog({
  worktree,
  project,
  sourceIdentity,
  localProject,
  sourceDeviceLabel,
  onClose,
}: {
  // The source pair, on the remote device this page is scoped to.
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  // The identity-matched project on this machine the worktree lands in.
  localProject: Project;
  sourceDeviceLabel: string;
  onClose: () => void;
}) {
  const thisDeviceLabel = useLocalDeviceName();
  const pull = usePullWorktree({
    worktree,
    sourceProjectId: project.id,
    sourceIdentity,
    localProjectId: localProject.id,
  });
  // The leave-out rule and the setup switch, the mirror's pair. Under
  // the source scope: its ignored list walks the checkout over the
  // device link.
  const choice = usePullChoice(project.id, worktree.id);
  const mode = modeOf(choice.selection);
  const bringsFiles = pullBringsIgnoredFiles(mode);
  const { stage, elapsed, progress, start, open } = usePullFlow({
    mutation: pull,
    sourceWorktreeId: worktree.id,
    choice: choice.choice,
    onClose,
  });

  return (
    <PullFlowFrame
      stage={stage}
      elapsed={elapsed}
      reviewIcon={ArrowRight}
      titles={TITLES}
      thisDeviceLabel={thisDeviceLabel}
      onClose={onClose}
      headline={
        <>
          {stage === "review" && (
            <>
              Move <span className="font-mono">{worktree.branch}</span> off{" "}
              {sourceDeviceLabel}, uncommitted work included.
            </>
          )}
          {stage === "running" &&
            `${stepHeadline(progress.frame, sourceDeviceLabel)}.`}
          {stage === "failed" && `Nothing on ${sourceDeviceLabel} changed.`}
          {stage === "done" && (
            <>
              <span className="font-mono">{worktree.branch}</span> now lives on{" "}
              {thisDeviceLabel}. What about the copy on {sourceDeviceLabel}?
            </>
          )}
        </>
      }
    >
      {stage === "review" && (
        <TransplantReview
          worktree={worktree}
          project={project}
          localProject={localProject}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          pull={choice}
          onCancel={onClose}
          onStart={start}
        />
      )}
      {(stage === "running" || stage === "failed") && (
        <TransplantProgress
          frame={progress.frame}
          phasesSeen={progress.phasesSeen}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          worktree={worktree}
          localProject={localProject}
          runSetup={choice.runSetup}
          error={stage === "failed" ? pull.error : undefined}
          onClose={onClose}
          onRetry={start}
          filesDetail={
            bringsFiles
              ? (selectionSummary(choice.selection) ??
                "everything ignored, too")
              : undefined
          }
        />
      )}
      {stage === "done" && pull.data && (
        <TransplantFinish
          result={pull.data}
          leftOutCount={
            mode === "custom"
              ? choice.selection.leftOut.size
              : mode === "everything"
                ? 0
                : null
          }
          worktree={worktree}
          project={project}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          onClose={onClose}
          onOpen={open}
        />
      )}
    </PullFlowFrame>
  );
}
