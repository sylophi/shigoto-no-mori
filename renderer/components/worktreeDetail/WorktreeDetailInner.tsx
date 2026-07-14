import { useNavigate } from "@tanstack/react-router";
import { SectionHeading } from "@/components/ui/section-heading";
import { PathSpan } from "@/components/ui/path-span";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { cn } from "@/lib/utils";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import {
  scriptKey,
  scriptRuns,
  slotToParam,
  useScriptRunState,
  type ScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import { useWorktreeCreatePhase } from "@/store/worktreeLifecycle";
import type {
  CleanupError,
  CreatePhase,
  Project,
  Worktree,
} from "@shared/schemas";
import { LauncherRow } from "./LauncherRow";
import { LifecycleBanner } from "./LifecycleBanner";
import { PullRequestSection } from "./pullRequests/PullRequestSection";
import { ScriptLaunchRow } from "./ScriptLaunchRow";
import { ScriptsSection } from "./scripts/ScriptsSection";
import {
  WorktreeDetailFooter,
  type WorktreeFooterActions,
  type WorktreeFooterState,
} from "./WorktreeDetailFooter";
import { BranchHeaderRow } from "./branch/BranchHeader";
import { CommitsSection } from "./commits/CommitsSection";
import { NotesSection } from "./NotesSection";

const CREATE_PHASE_LABEL = {
  carryOver: "Carrying over files...",
  setup: "Setting up...",
  portPoolProvision: "Provisioning ports...",
} satisfies Record<CreatePhase, string>;

interface InnerProps {
  worktree: Worktree;
  project: Project;
  siblings: Worktree[];
}

// Split from WorktreeDetail so per-worktree hooks (teardown state,
// deletion phase) only attach when worktree+project resolved. Avoids
// short-lived subscriptions on empty keys.
export function WorktreeDetailInner({
  worktree,
  project,
  siblings,
}: InnerProps) {
  const navigate = useNavigate();
  const { data: runtime } = useRuntimeInfo();
  const {
    deleteMutation,
    needsForce,
    cleanupError,
    runDelete,
    cancelForce,
    retryCleanup,
    skipCleanup,
    clearCleanupError,
  } = useDeleteAndNavigate(worktree, siblings);
  const { armed: confirmDelete, trigger: confirmDeleteTrigger } =
    useConfirmTwice(CONFIRM_QUICK_MS);

  // Derive limbo state from script-runs: any cleanup-tier script
  // currently running indicates we're mid-cleanup; otherwise if the
  // mutation is in flight we're in the remove phase.
  const teardownKey = scriptKey(worktree.projectId, worktree.id, {
    kind: "teardown",
  });
  const releaseKey = scriptKey(worktree.projectId, worktree.id, {
    kind: "portPool",
    phase: "release",
  });
  const teardownState = useScriptRunState(teardownKey);
  const releaseState = useScriptRunState(releaseKey);
  const home = runtime?.homedir ?? null;

  const cleanupRunning =
    teardownState.status === "running" ||
    teardownState.status === "starting" ||
    releaseState.status === "running" ||
    releaseState.status === "starting";
  const busy = deleteMutation.isPending;
  const inLimbo = cleanupRunning || busy;

  // Banner-only for setup / port-pool provision: those are user scripts
  // (`pnpm install` etc.) that can run alongside the user opening files
  // or kicking off launches. Carry-over moves real files into the new
  // worktree, so we lock the page until it finishes. inLimbo wins -- a
  // delete-during-setup race shows the destructive banner instead.
  const createPhase = useWorktreeCreatePhase(worktree.id);
  const createLabel =
    !inLimbo && createPhase ? CREATE_PHASE_LABEL[createPhase] : null;
  const locked = inLimbo || createPhase === "carryOver";

  const handleDelete = () => confirmDeleteTrigger(() => runDelete());
  const handleForceDelete = () => runDelete({ force: true });

  const handleCancelCleanup = () => {
    if (teardownState.runId) {
      void scriptRuns.cancel(teardownKey);
    }
    if (releaseState.runId) {
      void scriptRuns.cancel(releaseKey);
    }
  };

  const openCleanupConsole = () => {
    let slot: ScriptSlot;
    if (cleanupError) {
      slot =
        cleanupError.phase === "teardown"
          ? { kind: "teardown" }
          : { kind: "portPool", phase: "release" };
    } else if (releaseState.runId) {
      slot = { kind: "portPool", phase: "release" };
    } else if (teardownState.runId) {
      slot = { kind: "teardown" };
    } else {
      return;
    }
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
      params: {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        scriptKey: slotToParam(slot),
      },
    });
  };

  const limboLabel = computeLimboLabel(teardownState, releaseState);
  const cleanupCancelling = teardownState.cancelling || releaseState.cancelling;

  const footerState = computeFooterState({
    cleanupError,
    needsForce,
    cleanupRunning,
    cleanupCancelling,
    busy,
    confirmDelete,
    deleteErrorMessage: deleteMutation.error?.message,
  });
  const footerActions: WorktreeFooterActions = {
    onCancelCleanupError: clearCleanupError,
    onOpenCleanupConsole: openCleanupConsole,
    onRetryCleanup: retryCleanup,
    onSkipCleanup: skipCleanup,
    onCancelForce: cancelForce,
    onForceDelete: handleForceDelete,
    onCancelCleanup: handleCancelCleanup,
    onDelete: handleDelete,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2 border-b border-border px-6 pt-7 pb-5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/projects/$projectId/configure",
                params: { projectId: worktree.projectId },
              })
            }
            className="shrink-0 rounded transition-colors hover:text-foreground"
            title={`Configure ${project.name}`}
          >
            {project.name}
          </button>
          <span aria-hidden className="text-muted-foreground/40">
            /
          </span>
          <PathSpan
            path={worktree.path}
            home={home}
            className="min-w-0 flex-1 font-mono"
            copyable
          />
          <WorktreeKindIcon worktree={worktree} />
        </div>
        <BranchHeaderRow worktree={worktree} />
      </header>

      {inLimbo ? (
        <LifecycleBanner label={limboLabel} />
      ) : createLabel ? (
        <LifecycleBanner label={createLabel} />
      ) : null}

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-6 py-6",
          locked && "pointer-events-none opacity-50",
        )}
        aria-disabled={locked}
      >
        <div className="flex max-w-4xl flex-col gap-10">
          <section className="space-y-3">
            <SectionHeading>Launch</SectionHeading>
            {/* The two rows are one wrapping group of pills, so they sit a
                pill-gap apart -- not the section's heading-to-content gap. */}
            <div className="space-y-2">
              <LauncherRow worktree={worktree} />
              <ScriptLaunchRow worktree={worktree} />
            </div>
          </section>

          <PullRequestSection worktree={worktree} />

          <CommitsSection worktree={worktree} />

          <section className="space-y-3">
            <SectionHeading>Scripts</SectionHeading>
            <ScriptsSection worktree={worktree} />
          </section>

          <NotesSection worktree={worktree} />
        </div>
      </div>

      <WorktreeDetailFooter
        worktree={worktree}
        state={footerState}
        actions={footerActions}
      />
    </div>
  );
}

// Collapse the loose deletion flags into the footer's discriminated
// state. Order is priority: a cleanup failure and a pending force-delete
// each override the running/normal views, matching how a delete attempt
// walks through these phases.
function computeFooterState(input: {
  cleanupError: CleanupError | null;
  needsForce: boolean;
  cleanupRunning: boolean;
  cleanupCancelling: boolean;
  busy: boolean;
  confirmDelete: boolean;
  deleteErrorMessage: string | undefined;
}): WorktreeFooterState {
  if (input.cleanupError) {
    return { kind: "cleanupError", error: input.cleanupError };
  }
  if (input.needsForce) {
    return {
      kind: "needsForce",
      errorMessage: input.deleteErrorMessage,
      busy: input.busy,
    };
  }
  if (input.cleanupRunning) {
    return { kind: "cleanupRunning", cancelling: input.cleanupCancelling };
  }
  return {
    kind: "normal",
    confirmDelete: input.confirmDelete,
    busy: input.busy,
  };
}

// Decide which limbo phase label to show -- release runs before
// teardown, then the actual git remove.
function computeLimboLabel(
  teardownState: ScriptRunState,
  releaseState: ScriptRunState,
): string {
  if (releaseState.status === "running" || releaseState.status === "starting") {
    return releaseState.cancelling
      ? "Stopping port-pool release..."
      : "Releasing ports...";
  }
  if (
    teardownState.status === "running" ||
    teardownState.status === "starting"
  ) {
    return teardownState.cancelling
      ? "Stopping teardown..."
      : "Tearing down...";
  }
  return "Removing worktree...";
}
