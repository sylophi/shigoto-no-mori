import { DeviceChip } from "@/components/shared/DeviceChip";
import { PAGE_HEADER_PADDING } from "@/components/shared/PageHeader";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { SectionHeading } from "@/components/ui/section-heading";
import { PathSpan } from "@/components/ui/path-span";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { cn } from "@/lib/utils";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import {
  useScriptRuns,
  useScriptRunState,
} from "@/hooks/scripts/useScriptRuns";
import { useDeleteAndNavigate } from "@/hooks/worktrees/useDeleteAndNavigate";
import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import {
  scriptKey,
  type ScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import {
  CREATE_PHASE_LABEL,
  useWorktreeCreatePhase,
} from "@/store/worktreeLifecycle";
import type { Project, Worktree } from "@shared/schemas";
import { BirthdayBanner } from "@/components/villagers/BirthdayBanner";
import { LaunchSection } from "./LaunchSection";
import { LifecycleBanner } from "./LifecycleBanner";
import { MirrorPill } from "./MirrorPill";
import { MirrorAction } from "./mirror/MirrorAction";
import { PeerTransferActions } from "./PeerTransferActions";
import { FilesButton } from "./FilesButton";
import { PortsButton } from "./ports/PortsButton";
import { RemoteTransferActions } from "./RemoteWorktreeActions";
import { PullRequestSection } from "./pullRequests/PullRequestSection";
import { ScriptsSection } from "./scripts/ScriptsSection";
import {
  WorktreeDetailFooter,
  type WorktreeFooterActions,
  type WorktreeFooterState,
} from "./WorktreeDetailFooter";
import { BranchTitle } from "./branch/BranchTitle";
import { WorktreeActivityIndicator } from "./WorktreeActivityIndicator";
import { CommitsSection } from "./commits/CommitsSection";
import { NotesSection } from "./NotesSection";

// A cleanup script still in flight.
const live = (state: ScriptRunState) =>
  state.status === "running" || state.status === "starting";

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
  const { toScript } = useWorktreeNav();
  // Configure exists for every device, so the breadcrumb links there
  // whichever device the page is scoped to.
  const { toProjectPage } = useProjectNav();
  // Which device this page is scoped to. Everything data-shaped below
  // already rides the host scope. `remote` only gates what is local by
  // nature (the create-phase lock, while LaunchSection gates launching
  // itself) and adds the cross-device ones (mirror, transplant, the
  // device chip).
  const { remote } = useHostScope();
  const scriptRuns = useScriptRuns();
  // Always true locally (the local device is granted by contract), so
  // this alone carries the read-only mirror.
  // While the verdict is still in flight, assume granted rather than
  // flashing a read-only page that turns editable a moment later (the
  // same rule PeerDeviceSettings and VersionSection follow).
  const { canCommand: granted } = useCommandAccess();
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

  const cleanupRunning = live(teardownState) || live(releaseState);
  // This page's own delete, or a removal the host announced (a mirror
  // stop takes the copy with it, a peer's transplant tears its source
  // down here): the page goes into limbo either way, instead of
  // standing as an ordinary worktree until the row vanishes.
  const busy = useIsDeletingWorktree(worktree.id);
  const inLimbo = cleanupRunning || busy;

  // Banner-only for setup / port-pool provision: those are user scripts
  // (`pnpm install` etc.) that can run alongside the user opening files
  // or kicking off launches. Carry-over moves real files into the new
  // worktree, so we lock the page until it finishes. inLimbo wins, so a
  // delete-during-setup race shows the destructive banner instead.
  // Scoped to this machine: the lifecycle broadcast is local, and a
  // pull can mint a local worktree with the SAME id as the peer's (ids
  // hash the managed path), so a peer's page must not lock for it.
  const createPhase = useWorktreeCreatePhase(remote ? null : worktree.id);
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
    toScript(worktree.projectId, worktree.id, slot);
  };

  const limboLabel = computeLimboLabel(teardownState, releaseState);
  const bannerLabel = inLimbo ? limboLabel : createLabel;
  const cleanupCancelling = teardownState.cancelling || releaseState.cancelling;

  // Collapse the loose deletion flags into the footer's discriminated
  // state. Order is priority: a cleanup failure and a pending force-delete
  // each override the running/normal views, matching how a delete attempt
  // walks through these phases.
  const footerState: WorktreeFooterState = cleanupError
    ? { kind: "cleanupError", error: cleanupError }
    : needsForce
      ? {
          kind: "needsForce",
          errorMessage: deleteMutation.error?.message,
          busy,
        }
      : cleanupRunning
        ? { kind: "cleanupRunning", cancelling: cleanupCancelling }
        : { kind: "normal", confirmDelete, busy };
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
      <header
        className={cn(
          "flex flex-col gap-2 border-b border-border",
          PAGE_HEADER_PADDING,
          "pb-5 phone:pb-4",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => toProjectPage("configure", worktree.projectId)}
            className="shrink-0 rounded transition-colors hover:text-foreground"
            title={`Configure ${project.name}`}
          >
            {project.name}
          </button>
          {/* A phone has no room for the path (it shortens to noise
              at that width), so the breadcrumb stops at the project
              and the trailing marks push themselves to the edge. */}
          <span aria-hidden className="text-muted-foreground/40 phone:hidden">
            /
          </span>
          <PathSpan
            path={worktree.path}
            home={home}
            className="min-w-0 flex-1 font-mono phone:hidden"
            copyable
          />
          <span className="flex shrink-0 items-center gap-1.5 phone:ml-auto">
            <WorktreeKindIcon worktree={worktree} />
            <DeviceChip />
          </span>
        </div>
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <BranchTitle worktree={worktree} />
          </div>
          <WorktreeActivityIndicator worktree={worktree} />
        </div>
        <MirrorPill worktree={worktree} />
      </header>

      {bannerLabel ? (
        <LifecycleBanner label={bannerLabel} />
      ) : (
        <BirthdayBanner worktree={worktree} />
      )}

      <div
        className={cn(
          PAGE_BODY,
          "phone:py-5",
          locked && "pointer-events-none opacity-50",
        )}
        aria-disabled={locked}
      >
        <div className="flex flex-col gap-10 phone:gap-8">
          <LaunchSection worktree={worktree} />

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
        canMutate={granted}
        leading={
          <>
            {/* The same leading verbs on either page: Ports and the
                running mirror's button, then the transfers. This
                device's own worktree footer verbs (PeerTransferActions)
                sit in the spots the remote footer gives its Ports,
                Mirror and Transplant buttons. */}
            <FilesButton worktree={worktree} />
            <PortsButton worktree={worktree} />
            <MirrorAction worktree={worktree} />
            {remote ? (
              <RemoteTransferActions worktree={worktree} project={project} />
            ) : (
              <PeerTransferActions worktree={worktree} project={project} />
            )}
          </>
        }
      />
    </div>
  );
}

// Decide which limbo phase label to show. Release runs before
// teardown, then the actual git remove.
function computeLimboLabel(
  teardownState: ScriptRunState,
  releaseState: ScriptRunState,
): string {
  if (live(releaseState)) {
    return releaseState.cancelling
      ? "Stopping port-pool release..."
      : "Releasing ports...";
  }
  if (live(teardownState)) {
    return teardownState.cancelling
      ? "Stopping teardown..."
      : "Tearing down...";
  }
  return "Removing worktree...";
}
