// The local worktree footer's ways out to another of the account's
// devices, the remote footer's "Mirror here" and "Transplant here"
// turned around: a live copy of this worktree on a peer ("Mirror
// to…"), or moving it there ("Transplant to…"). Both wait on what the
// remote pair waits on (a real branch of its own, a repo identity) and
// on another device that hosts projects (one without the repo clones
// it first). Which peer is the dialog's question (flow/peerTargets.ts),
// so the buttons only open it. The primary
// checkout can be mirrored but not transplanted: it is the project
// itself and cannot be torn down. TransferActionsView draws them, and
// a peer's (RemoteWorktreeActions.tsx).
import {
  isRealBranch,
  type Project,
  type Worktree,
} from "@shigomori/contracts/schemas";
import {
  useLocalMirrorBlocker,
  useWorktreeMirrorLinks,
  type WorktreeMirrorLink,
} from "@/hooks/remote/useMirrors";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import {
  type TransferDialog,
  TransferActionsView,
} from "@shigomori/ui/views/worktreeDetail/TransferActionsView.tsx";
import { usePeerTargets, type PeerTarget } from "./flow/peerTargets";
import { MirrorToDialog } from "./mirror/MirrorDialog";
import { TransplantToDialog } from "./transplant/TransplantDialog";

export interface TransferPartProps {
  worktree: Worktree;
  project: Project;
  part: "footer" | "option";
  open: TransferDialog;
  setOpen: (open: TransferDialog) => void;
}

// The repo identity a transfer of the worktree goes by, or null when
// it has none to go by: both transfers need a real branch of its own
// and a repo identity, on either page.
export function transferSource(
  worktree: Worktree,
  project: Project,
): string | null {
  return worktree.detached || !isRealBranch(worktree.branch)
    ? null
    : (project.identity ?? null);
}

// What the transfers offer a worktree with a transferSource, read by
// the footer and the sidebar's worktree menu alike. A worktree already
// part of a mirror offers neither: its running mirror's button
// (MirrorAction) is where that one is managed, a worktree holds one
// mirror, and moving one half of a live pair away is what the mirror's
// own stop is for.
export interface TransferOffers {
  mirror: boolean;
  mirrorBlocker: string | undefined;
  transplant: boolean;
  // A running mirror there is a session to manage through.
  mirroring: boolean;
}

export function hasManageableMirror(
  links: readonly WorktreeMirrorLink[],
): boolean {
  return links.some(
    (link) => link.session !== undefined && link.runnerApi !== undefined,
  );
}

// This device's worktree: the transfers also wait on another device
// that hosts projects (one without the repo clones it first).
export function usePeerTransferOffers(
  worktree: Worktree,
  project: Project,
): TransferOffers & { targets: PeerTarget[] } {
  const targets = usePeerTargets(project);
  const links = useWorktreeMirrorLinks(worktree);
  const mirrorBlocker = useLocalMirrorBlocker();
  const canOpen = targets.length > 0 && links.length === 0;
  return {
    targets,
    // App only, like "Mirror here": the daemon lives in the host.
    mirror: canOpen && canForwardPorts,
    mirrorBlocker,
    transplant: canOpen && !worktree.isPrimary,
    mirroring: hasManageableMirror(links),
  };
}

export function PeerTransferActions(props: TransferPartProps) {
  const sourceIdentity = transferSource(props.worktree, props.project);
  if (sourceIdentity === null) return null;
  return <TransferButtons {...props} sourceIdentity={sourceIdentity} />;
}

function TransferButtons({
  worktree,
  project,
  part,
  open,
  setOpen,
  sourceIdentity,
}: TransferPartProps & { sourceIdentity: string }) {
  const offers = usePeerTransferOffers(worktree, project);
  const dialog = {
    worktree,
    project,
    sourceIdentity,
    targets: offers.targets,
    onClose: () => setOpen(null),
  };
  return (
    <TransferActionsView
      part={part}
      here={false}
      mirror={offers.mirror ? { blocker: offers.mirrorBlocker } : null}
      transplant={offers.transplant}
      // The buttons need a target. An OPEN dialog does not: a run in
      // progress keeps its progress, its finish-up step and its report
      // when the roster empties under it (a sign-out, a revoke), and
      // says what failed rather than vanishing mid-run.
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
