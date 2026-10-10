// The local worktree footer's ways out to another of the account's
// devices, the remote footer's "Mirror here" and "Transplant here"
// turned around: a live copy of this worktree on a peer ("Mirror
// to…"), or moving it there ("Transplant to…"). Both wait on what the
// remote pair waits on (a real branch of its own, a repo identity) and
// on another device that hosts projects (one without the repo clones
// it first). Which peer is the dialog's question (flow/peerTargets.ts),
// so the buttons only open it. The primary
// checkout can be mirrored but not transplanted: it is the project
// itself and cannot be torn down. The page renders this twice: the
// footer part (Mirror and the open dialog) and the Options popover's
// row (Transplant, used far less), sharing which dialog is open, so the
// dialog outlives the popover that opened it.
import { RefreshCw, Shovel } from "lucide-react";
import {
  isRealBranch,
  type Project,
  type Worktree,
} from "@shigomori/contracts/schemas";
import {
  useLocalMirrorBlocker,
  useWorktreeMirrorLinks,
} from "@/hooks/remote/useMirrors";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { FooterActionButtonView } from "@shigomori/ui/views/worktreeDetail/FooterActionButtonView.tsx";
import { LABEL_RANK } from "@shigomori/ui/views/worktreeDetail/FooterVerbView.tsx";
import { OptionActionView } from "@shigomori/ui/views/worktreeDetail/WorktreeOptionsView.tsx";
import { usePeerTargets } from "./flow/peerTargets";
import { MirrorToDialog } from "./mirror/MirrorDialog";
import { TransplantToDialog } from "./transplant/TransplantDialog";

// Which transfer dialog is open, held by the page across both parts.
export type TransferDialog = "mirror" | "transplant" | null;

export interface TransferPartProps {
  worktree: Worktree;
  project: Project;
  part: "footer" | "option";
  open: TransferDialog;
  setOpen: (open: TransferDialog) => void;
}

export function PeerTransferActions(props: TransferPartProps) {
  const { worktree, project } = props;
  if (
    worktree.detached ||
    !isRealBranch(worktree.branch) ||
    project.identity == null
  ) {
    return null;
  }
  return <TransferButtons {...props} sourceIdentity={project.identity} />;
}

function TransferButtons({
  worktree,
  project,
  part,
  open,
  setOpen,
  sourceIdentity,
}: TransferPartProps & { sourceIdentity: string }) {
  const targets = usePeerTargets(project);
  // A worktree already part of a mirror, run here or by a peer, has
  // its Mirror button beside these (MirrorAction), which is where that
  // one is managed, and a worktree holds one mirror.
  const mirrored = useWorktreeMirrorLinks(worktree).length > 0;
  const mirrorBlocker = useLocalMirrorBlocker();
  // The buttons need a target. An OPEN dialog does not: a run in
  // progress keeps its progress, its finish-up step and its report
  // when the roster empties under it (a sign-out, a revoke), and says
  // what failed rather than vanishing mid-run.
  const canOpen = targets.length > 0;
  if (part === "option") {
    // Not while mirrored: moving one half of a live pair away is what
    // the mirror's own stop is for.
    return (
      canOpen &&
      !worktree.isPrimary &&
      !mirrored && (
        <OptionActionView
          icon={<Shovel />}
          label="Transplant"
          description="Move this worktree to another device."
          onClick={() => setOpen("transplant")}
        />
      )
    );
  }
  const dialog = {
    worktree,
    project,
    sourceIdentity,
    targets,
    onClose: () => setOpen(null),
  };
  return (
    <>
      {/* App only, like "Mirror here": the daemon lives in main. */}
      {canOpen && canForwardPorts && !mirrored && (
        <FooterActionButtonView
          rank={LABEL_RANK.mirrorTo}
          icon={<RefreshCw />}
          label="Mirror"
          tip="Keep a live copy of this worktree on another device"
          disabledReason={mirrorBlocker}
          onClick={() => setOpen("mirror")}
        />
      )}
      {open === "mirror" && <MirrorToDialog {...dialog} />}
      {open === "transplant" && <TransplantToDialog {...dialog} />}
    </>
  );
}
