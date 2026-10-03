import { DeviceChip } from "@/components/shared/DeviceChip";
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
import { useResident } from "@/hooks/villagers/useResident";
import { LaunchSection } from "./LaunchSection";
import { MirrorPill } from "./MirrorPill";
import { MirrorAction } from "./mirror/MirrorAction";
import { PeerTransferActions } from "./PeerTransferActions";
import { FilesButton } from "./FilesButton";
import { PortsButton } from "./ports/PortsButton";
import { RemoteTransferActions } from "./RemoteWorktreeActions";
import { PullRequestSection } from "./pullRequests/PullRequestSection";
import { ScriptsSection } from "./scripts/ScriptsSection";
import { WorktreeDetailFooter } from "./WorktreeDetailFooter";
import type {
  WorktreeFooterActions,
  WorktreeFooterState,
} from "./WorktreeDetailFooterView";
import { BranchTitle } from "./branch/BranchTitle";
import { WorktreeActivityIndicator } from "./WorktreeActivityIndicator";
import { CommitsSection } from "./commits/CommitsSection";
import { NotesSection } from "./NotesSection";
import { WorktreeDetailView } from "./WorktreeDetailView";

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
  const resident = useResident(worktree);
  const {
    deleteMutation,
    needsForce,
    cleanupError,
    runDelete,
    deleteBlockedReason,
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
  // The resident's birthday party, with their face to throw it, and
  // never over a create or a removal.
  const party =
    resident?.birthday === true &&
    resident.face !== null &&
    bannerLabel === null;
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
        : {
            kind: "normal",
            confirmDelete,
            busy,
            deleteBlockedReason,
          };
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
    <WorktreeDetailView
      worktree={worktree}
      projectName={project.name}
      home={home}
      onOpenProject={() => toProjectPage("configure", worktree.projectId)}
      deviceChip={<DeviceChip />}
      resident={resident}
      party={party}
      title={<BranchTitle worktree={worktree} />}
      activity={<WorktreeActivityIndicator worktree={worktree} />}
      mirror={<MirrorPill worktree={worktree} />}
      banner={bannerLabel}
      locked={locked}
      launch={<LaunchSection worktree={worktree} />}
      pullRequest={<PullRequestSection worktree={worktree} />}
      commits={<CommitsSection worktree={worktree} />}
      scripts={<ScriptsSection worktree={worktree} />}
      notes={<NotesSection worktree={worktree} />}
      footer={
        <WorktreeDetailFooter
          worktree={worktree}
          state={footerState}
          actions={footerActions}
          canMutate={granted}
          leading={
            <>
              {/* The same leading verbs on either page: Ports and the
                  running mirror's button, then the transfers. This
                  device's own worktree footer verbs
                  (PeerTransferActions) sit in the spots the remote
                  footer gives its Ports, Mirror and Transplant
                  buttons. */}
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
      }
    />
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
