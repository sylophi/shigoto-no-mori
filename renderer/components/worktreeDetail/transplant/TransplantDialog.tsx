// The transplant flow, shaped after the owner's remote-ops mockups and
// honest to the backend: three steps on one rail. Review lists what
// travels and where it lands. Transplant is the pull with its progress
// frames read into four named steps. Finish up source shows the landed
// worktree and asks what happens to the copy on the source device
// (keep, shelve, or tear down). The move is the pull mutation: the
// last step is the report, and the mutation's own status is the
// stage.
import { useState } from "react";
import { ArrowRight, Check, Loader2, X, type LucideIcon } from "lucide-react";
import { pullBringsIgnoredFiles } from "@shared/ipc/modules/sync";
import type { Project, Worktree } from "@shared/schemas";
import { ModalShell } from "@/components/ui/modal-shell";
import { TONE_PILL } from "@/components/ui/status-dot";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { usePullWorktree } from "@/hooks/remote/usePullWorktree";
import { usePullProgress } from "@/hooks/remote/usePullProgress";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import {
  modeOf,
  selectionSummary,
  usePullChoice,
} from "../mirror/ignoreChoice";
import { FlowHeader, StepRail } from "./TransplantChrome";
import { TransplantFinish } from "./TransplantFinish";
import { TransplantProgress } from "./TransplantProgress";
import { TransplantReview } from "./TransplantReview";
import { stepHeadline, useClock } from "./transplantSteps";

type Stage = "review" | "running" | "failed" | "done";

const HEADER: Record<
  Stage,
  { tint: string; icon: LucideIcon; spin?: boolean; title: string }
> = {
  review: {
    tint: "bg-accent text-accent-foreground",
    icon: ArrowRight,
    title: "Transplant worktree",
  },
  running: {
    tint: TONE_PILL.sky,
    icon: Loader2,
    spin: true,
    title: "Transplanting",
  },
  failed: { tint: TONE_PILL.rose, icon: X, title: "Transplant stopped" },
  done: { tint: TONE_PILL.emerald, icon: Check, title: "Transplant complete" },
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
  const nav = useWorktreeNav();
  const thisDeviceLabel = useLocalDeviceName();
  const pull = usePullWorktree({
    worktree,
    sourceProjectId: project.id,
    sourceIdentity,
    localProjectId: localProject.id,
  });
  const stage: Stage = pull.isPending
    ? "running"
    : pull.isError
      ? "failed"
      : pull.isSuccess
        ? "done"
        : "review";
  // The attempt's clock: the mutation's own submit time, frozen at the
  // moment it settles.
  const [endedAt, setEndedAt] = useState(0);
  const now = useClock(stage === "running");
  const progress = usePullProgress(worktree.id);
  // The leave-out rule and the setup switch, the mirror's pair. Under
  // the source scope: its ignored list walks the checkout over the
  // device link.
  const choice = usePullChoice(project.id, worktree.id);
  const mode = modeOf(choice.selection);
  const bringsFiles = pullBringsIgnoredFiles(mode);

  const start = () => {
    progress.reset();
    pull.mutate(choice.choice, { onSettled: () => setEndedAt(Date.now()) });
  };

  const open = () => {
    if (!pull.data) return;
    onClose();
    // The landed worktree is local, so leave the remote scope behind
    // explicitly rather than through the scoped nav.
    nav.toLocalWorktree(pull.data.worktree.projectId, pull.data.worktree.id);
  };

  const header = HEADER[stage];
  const elapsed = (stage === "running" ? now : endedAt) - pull.submittedAt;

  return (
    <ModalShell
      // While the pull runs neither Escape nor the backdrop may close
      // the dialog: the mutation is quiet, so dismissing it would end
      // the flow with no report and no way back to the last step.
      onClose={stage === "running" ? () => {} : onClose}
      closeOnEscape={stage !== "running"}
      popoverClassName="flex max-h-[85vh] max-w-4xl flex-col"
    >
      <FlowHeader
        tint={header.tint}
        icon={header.icon}
        spin={header.spin}
        title={`${header.title}${stage === "running" ? ` to ${thisDeviceLabel}` : ""}`}
        elapsed={
          stage === "review"
            ? undefined
            : { ms: elapsed, label: stage === "running" ? "elapsed" : "total" }
        }
        onClose={onClose}
      >
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
      </FlowHeader>

      <StepRail current={stage === "review" ? 0 : stage === "done" ? 2 : 1} />

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
    </ModalShell>
  );
}
