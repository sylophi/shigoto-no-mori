// The worktree footer's ways to another of the account's devices,
// drawn by TransferActionsView in two parts the page places (a button
// of the footer, a row of its Options popover). This device's worktree
// goes out to a peer: a live copy of it there ("Mirror to…"), or moved
// there ("Transplant to…"), which wait on another device that hosts
// projects (one without the repo clones it first), and which peer is
// the dialog's question (flow/peerTargets.ts). A peer's worktree comes
// here: a live mirror of it ("Mirror here") or moved here, deciding
// what becomes of the source ("Transplant"), which wait on the grant.
// No local project sharing it is not a stop: the dialogs clone the
// repo here first. Either way a transfer needs a real branch of its
// own and a repo identity to match a project by (the handlers
// re-verify the match). A primary checkout can be mirrored but not
// transplanted: it is the project itself and cannot be torn down. The
// running mirror's button, on a worktree already part of one
// (mirror/MirrorAction.tsx), stands in for these: a worktree holds one
// mirror. So does a move queued for an offline device, until it ran
// (QueuedMoveAction.tsx).
import {
  isRealBranch,
  type Project,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import {
  useLocalMirrorBlocker,
  useMirrorHereBlocker,
  useWorktreeMirrorLinks,
} from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useDevices";
import { useQueuedMoveOf } from "@/hooks/remote/useMoveQueue";
import { useHasLocalHost } from "@/lib/localHost";
import {
  type TransferDialog,
  TransferActionsView,
} from "@shigomori/ui/views/worktreeDetail/TransferActionsView.tsx";
import { NoIdentityNoteView } from "@shigomori/ui/views/worktreeDetail/NoIdentityNoteView.tsx";
import {
  useMayTransfer,
  usePeerTargets,
  type PeerTarget,
} from "./flow/peerTargets";
import { MirrorDialog, MirrorToDialog } from "./mirror/MirrorDialog";
import {
  TransplantDialog,
  TransplantToDialog,
} from "./transplant/TransplantDialog";

interface TransferPartProps {
  worktree: Worktree;
  project: Project;
  part: "footer" | "option";
  open: TransferDialog;
  setOpen: (open: TransferDialog) => void;
}

export function hasOwnBranch(worktree: Worktree): boolean {
  return !worktree.detached && isRealBranch(worktree.branch);
}

// What the transfers offer, read by the footer and the sidebar's
// worktree menu alike. A worktree already part of a mirror offers
// neither: its running mirror's button is where that one is managed,
// and moving one half of a live pair away is what the mirror's own
// stop is for.
export interface TransferOffers {
  mirror: boolean;
  mirrorBlocker: string | undefined;
  transplant: boolean;
  // A running mirror there is a session to manage through.
  mirroring: boolean;
}

// What one side reads for itself: whether its transfers can open now,
// and what holds its mirror back.
interface TransferSide {
  ready: boolean;
  mirrorBlocker: string | undefined;
}

// The side's reads stay with it (a peer's targets are this device's
// question alone), and the offers are the same rule on either.
export function useTransferOffers(
  worktree: Worktree,
  { ready, mirrorBlocker }: TransferSide,
): TransferOffers {
  // App only: the mirror's daemon lives in the host, and a copy or a
  // move here lands on this machine, which a browser is not.
  const hasLocalHost = useHasLocalHost();
  const links = useWorktreeMirrorLinks(worktree);
  // A move queued for it stands in for both (QueuedMoveAction.tsx).
  const queued = useQueuedMoveOf(worktree);
  // The branch is checked again for a dialog held open past it.
  const canOpen =
    hasLocalHost &&
    ready &&
    hasOwnBranch(worktree) &&
    links.length === 0 &&
    queued === undefined;
  return {
    mirror: canOpen,
    mirrorBlocker,
    transplant: canOpen && !worktree.isPrimary,
    mirroring: links.some(
      (link) => link.session !== undefined && link.runnerApi !== undefined,
    ),
  };
}

// This device's worktree, out to a peer.
export function useToPeerSide(
  project: Project,
): TransferSide & { targets: PeerTarget[] } {
  const targets = usePeerTargets(project);
  return {
    targets,
    ready: targets.length > 0,
    mirrorBlocker: useLocalMirrorBlocker(),
  };
}

// A peer's worktree, under its scope, here.
export function useHereSide(): TransferSide & { deviceLabel: string } {
  const { deviceId } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  return {
    deviceLabel,
    ready: useMayTransfer(),
    mirrorBlocker: useMirrorHereBlocker(deviceLabel),
  };
}

// The two transfers, or the one line that explains their absence.
export function TransferActions(props: TransferPartProps) {
  const { worktree, project, part, open } = props;
  const { remote } = useHostScope();
  // The page holds which dialog is open, so an open one outlives the
  // buttons: a run in progress keeps its progress, its finish-up step
  // and its report when what offered it goes (a sign-out, a revoke, the
  // grant reading undefined while the direct link blips, the mirror it
  // starts), and says what failed rather than vanishing mid-run.
  // Always granted locally.
  const mayTransfer = useMayTransfer();
  const hasLocalHost = useHasLocalHost();
  if (!(mayTransfer && hasOwnBranch(worktree)) && open === null) return null;
  // A peer's project git couldn't identify can never match one here,
  // so no transfer of it will ever work. Say so: two controls
  // disappearing without a word reads as a bug, and the cause (the
  // repo, not the app) is fixable by the person looking at it.
  if (project.identity == null) {
    return (
      remote && hasLocalHost && part === "footer" && <NoIdentityNoteView />
    );
  }
  const Side = remote ? TransfersHere : TransfersToPeer;
  return <Side {...props} sourceIdentity={project.identity} />;
}

function TransfersToPeer({
  worktree,
  project,
  part,
  open,
  setOpen,
  sourceIdentity,
}: TransferPartProps & { sourceIdentity: string }) {
  const side = useToPeerSide(project);
  const offers = useTransferOffers(worktree, side);
  const dialog = {
    worktree,
    project,
    sourceIdentity,
    targets: side.targets,
    onClose: () => setOpen(null),
  };
  return (
    <TransferActionsView
      part={part}
      here={false}
      mirror={offers.mirror ? { blocker: offers.mirrorBlocker } : null}
      transplant={offers.transplant}
      dialog={
        open === "mirror" ? (
          <MirrorToDialog {...dialog} />
        ) : open === "transplant" ? (
          <TransplantToDialog {...dialog} />
        ) : null
      }
      onOpen={setOpen}
    />
  );
}

function TransfersHere({
  worktree,
  project,
  part,
  open,
  setOpen,
  sourceIdentity,
}: TransferPartProps & { sourceIdentity: string }) {
  const side = useHereSide();
  const offers = useTransferOffers(worktree, side);
  // With no checkout on this machine the dialogs clone the repo first
  // (over the device link, so a repo with no remote comes too), and say
  // where.
  const localProject = useLocalProjectForIdentity(sourceIdentity);
  const dialog = {
    worktree,
    project,
    sourceIdentity,
    localProject,
    sourceDeviceLabel: side.deviceLabel,
    onClose: () => setOpen(null),
  };
  return (
    <TransferActionsView
      part={part}
      here
      // Mirror is the peer's send followed by a live two-way mirror
      // between its worktree and the new copy here, both run on the
      // peer, which holds the original, asked for through this device's
      // own start and driven by the mirror dialog.
      mirror={offers.mirror ? { blocker: offers.mirrorBlocker } : null}
      // Transplant is destructive on the remote side, so it opens the
      // review dialog: the dialog is the confirmation.
      transplant={offers.transplant}
      dialog={
        open === "mirror" ? (
          <MirrorDialog {...dialog} />
        ) : open === "transplant" ? (
          <TransplantDialog {...dialog} />
        ) : null
      }
      onOpen={setOpen}
    />
  );
}
