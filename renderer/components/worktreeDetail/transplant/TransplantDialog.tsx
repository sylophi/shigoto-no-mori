// The transplant flow, shaped after the owner's remote-ops mockups and
// honest to the backend: three steps on one rail. Review lists what
// travels and where it lands. Transplant is the pull with its progress
// frames read into four named steps. Finish up source shows the landed
// worktree and asks what happens to the copy on the source device
// (keep, shelve, or tear down). The move is the shared bring-here
// mutation, quieted: the last step is the report, and the mutation's
// own status is the stage.
import { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, X, type LucideIcon } from "lucide-react";
import type { Project, Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { useBringWorktreeHere } from "@/hooks/remote/useBringWorktreeHere";
import { usePullProgress } from "@/hooks/remote/usePullProgress";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { cn } from "@/lib/utils";
import { StepRail } from "./TransplantChrome";
import { TransplantFinish } from "./TransplantFinish";
import { TransplantProgress } from "./TransplantProgress";
import { TransplantReview } from "./TransplantReview";
import {
  currentStepIndex,
  formatElapsed,
  PULL_STEPS,
  stepHeadline,
} from "./transplantSteps";

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
    tint: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    icon: Loader2,
    spin: true,
    title: "Transplanting",
  },
  failed: {
    tint: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    icon: X,
    title: "Transplant stopped",
  },
  done: {
    tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: Check,
    title: "Transplant complete",
  },
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
  const pull = useBringWorktreeHere({
    worktree,
    sourceProjectId: project.id,
    sourceIdentity,
    localProjectId: localProject.id,
    quiet: true,
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

  const start = () => {
    progress.reset();
    pull.mutate(undefined, { onSettled: () => setEndedAt(Date.now()) });
  };

  const open = () => {
    if (!pull.data) return;
    onClose();
    // The landed worktree is local, so leave the remote scope behind
    // explicitly rather than through the scoped nav.
    nav.toLocalWorktree(pull.data.worktree.projectId, pull.data.worktree.id);
  };

  const stepIndex = currentStepIndex(progress.frame);
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
      <header className="flex items-start gap-3 px-5 py-4">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            header.tint,
          )}
        >
          <header.icon
            className={cn("size-4", header.spin && "animate-spin")}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">
            {header.title}
            {stage === "running" && ` to ${thisDeviceLabel}`}
          </h2>
          <p className="text-xs text-muted-foreground">
            {stage === "review" && (
              <>
                Move <span className="font-mono">{worktree.branch}</span> off{" "}
                {sourceDeviceLabel}, uncommitted work included.
              </>
            )}
            {stage === "running" &&
              `Step ${stepIndex + 1} of ${PULL_STEPS.length}: ${stepHeadline(PULL_STEPS[stepIndex], sourceDeviceLabel)}.`}
            {stage === "failed" && `Nothing on ${sourceDeviceLabel} changed.`}
            {stage === "done" && (
              <>
                <span className="font-mono">{worktree.branch}</span> now lives
                on {thisDeviceLabel}. What about the copy on {sourceDeviceLabel}
                ?
              </>
            )}
          </p>
        </div>
        {stage === "review" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
          >
            <X />
          </Button>
        ) : (
          <div className="shrink-0 text-right leading-tight">
            <p className="font-mono text-lg font-semibold tabular-nums">
              {formatElapsed(elapsed)}
            </p>
            <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {stage === "running" ? "elapsed" : "total"}
            </p>
          </div>
        )}
      </header>

      <StepRail current={stage === "review" ? 0 : stage === "done" ? 2 : 1} />

      {stage === "review" && (
        <TransplantReview
          worktree={worktree}
          project={project}
          localProject={localProject}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          onCancel={onClose}
          onStart={start}
        />
      )}
      {(stage === "running" || stage === "failed") && (
        <TransplantProgress
          frame={progress.frame}
          sourceDeviceLabel={sourceDeviceLabel}
          thisDeviceLabel={thisDeviceLabel}
          dirty={worktree.changedCount > 0}
          error={stage === "failed" ? pull.error : undefined}
          onClose={onClose}
          onRetry={start}
        />
      )}
      {stage === "done" && pull.data && (
        <TransplantFinish
          result={pull.data}
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

// A once-a-second tick while the transplant runs, for the elapsed
// figure. Frozen (and free) otherwise.
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}
