import { useState } from "react";
import type { ScriptRunState } from "@shigomori/ui/lib/scriptRun.ts";
import { DeviceChip } from "@/components/shared/DeviceChip";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
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
import { useWorktreeTitle } from "@/hooks/worktrees/useWorktreeTitle";
import { scriptKey, type ScriptSlot } from "@/store/scriptRuns";
import {
  CREATE_PHASE_LABEL,
  useWorktreeCreatePhase,
} from "@/store/worktreeLifecycle";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { BirthdayPartyView } from "@shigomori/ui/views/villagers/BirthdayPartyView.tsx";
import { ResidentFaceView } from "@shigomori/ui/views/villagers/ResidentFaceView.tsx";
import { useResident } from "@/hooks/villagers/useResident";
import { LaunchSection } from "./LaunchSection";
import { MirrorPill } from "./MirrorPill";
import { MirrorAction } from "./mirror/MirrorAction";
import { MirrorCopyTabs, useMirrorCopies } from "./mirror/MirrorCopyTabs";
import type { TransferDialog } from "@shigomori/ui/views/worktreeDetail/TransferActionsView.tsx";
import { PeerTransferActions } from "./PeerTransferActions";
import { FilesButton } from "./FilesButton";
import { PortsSection } from "./ports/PortsSection";
import { RemoteTransferActions } from "./RemoteWorktreeActions";
import { PullRequestLead } from "./pullRequests/PullRequestLead";
import { PullRequestSection } from "./pullRequests/PullRequestSection";
import { ScriptsSection } from "./scripts/ScriptsSection";
import { WorktreeDetailFooter } from "./WorktreeDetailFooter";
import type {
  WorktreeFooterActions,
  WorktreeFooterState,
} from "@shigomori/ui/views/worktreeDetail/WorktreeDetailFooterView.tsx";
import { WorktreeDetailView } from "@shigomori/ui/views/worktreeDetail/WorktreeDetailView.tsx";
import { TerminalButton } from "./TerminalButton";
import { NewWindowOption } from "./NewWindowOption";
import { TerminalDrawer } from "@/components/terminal/TerminalDrawer";
import { WorktreeHeader } from "./WorktreeHeader";
import { WorktreeLocation } from "./WorktreeLocation";
import { WorktreeActivityIndicator } from "./WorktreeActivityIndicator";
import { GitSection } from "./git/GitSection";
import { DescriptionSection } from "./DescriptionSection";

// A cleanup script still in flight.
const live = (state: ScriptRunState) =>
  state.status === "running" || state.status === "starting";

interface InnerProps {
  worktree: Worktree;
  project: Project;
  siblings: readonly Worktree[];
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
  // This device's worktree sends to a peer, a peer's brings here, and
  // either renders in two parts (the footer below) that share which
  // dialog is open.
  const Transfers = remote ? RemoteTransferActions : PeerTransferActions;
  const [transferDialog, setTransferDialog] = useState<TransferDialog>(null);
  const transfers = {
    worktree,
    project,
    open: transferDialog,
    setOpen: setTransferDialog,
  };
  const scriptRuns = useScriptRuns();
  // Always true locally (the local device is granted by contract). The
  // footer's verbs give way to the read-only note on it, and each
  // section's controls read the same verdict themselves.
  // While the verdict is still in flight, assume granted rather than
  // flashing a read-only page that turns editable a moment later (the
  // same rule PeerDeviceSettings and VersionSection follow).
  const { canCommand: granted } = useCommandAccess();
  const { data: runtime } = useRuntimeInfo();
  const resident = useResident(worktree);
  const mirrorCopies = useMirrorCopies(worktree);
  const { title, description, pullRequest } = useWorktreeTitle(worktree);
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
    resident?.birthday && resident.face !== null && bannerLabel === null
      ? resident
      : null;
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
      party={party && <BirthdayPartyView villager={party} />}
      copyTabs={mirrorCopies && <MirrorCopyTabs copies={mirrorCopies} />}
      projectName={project.name}
      onConfigure={() => toProjectPage("configure", worktree.projectId)}
      location={<WorktreeLocation worktree={worktree} home={home} />}
      marks={
        <>
          <WorktreeActivityIndicator worktree={worktree} />
          <WorktreeKindIcon worktree={worktree} />
          {/* With the copies' tabs, they name the device. */}
          {!mirrorCopies && <DeviceChip />}
        </>
      }
      face={<ResidentFaceView resident={resident} party={party !== null} />}
      header={
        <WorktreeHeader worktree={worktree} title={title} pr={pullRequest} />
      }
      mirrorPill={<MirrorPill worktree={worktree} />}
      banner={bannerLabel}
      locked={locked}
      description={
        description !== null && (
          <DescriptionSection
            // Folded again for another worktree or a new text.
            key={`${worktree.id}:${description}`}
            description={description}
          />
        )
      }
      prLead={pullRequest && <PullRequestLead worktree={worktree} />}
      launch={<LaunchSection worktree={worktree} />}
      prSection={!pullRequest && <PullRequestSection worktree={worktree} />}
      git={<GitSection worktree={worktree} />}
      // Keyed so an open add or edit form stays with its worktree.
      ports={<PortsSection key={worktree.id} worktree={worktree} />}
      scripts={<ScriptsSection worktree={worktree} />}
      footer={
        <WorktreeDetailFooter
          worktree={worktree}
          state={footerState}
          actions={footerActions}
          canMutate={granted}
          // The same verbs on either page: Files and the running mirror's
          // button, then the transfers. A new window on the page and
          // Transplant, used far less, are rows of the footer's Options
          // popover.
          leading={
            <>
              <FilesButton worktree={worktree} />
              <TerminalButton worktree={worktree} />
              <MirrorAction worktree={worktree} />
              <Transfers part="footer" {...transfers} />
            </>
          }
          options={
            <>
              <NewWindowOption worktree={worktree} />
              <Transfers part="option" {...transfers} />
            </>
          }
        />
      }
      drawer={<TerminalDrawer worktree={worktree} />}
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
