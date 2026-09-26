// The local worktree footer's ways out to another of the account's
// devices, the remote footer's "Mirror here" and "Transplant here"
// turned around: a live copy of this worktree on a peer ("Mirror
// to…"), or moving it there ("Transplant to…"). Both wait on what the
// remote pair waits on (a real branch of its own, a repo identity) and
// on another device that hosts projects (one without the repo clones
// it first). Which peer is the dialog's question (flow/peerTargets.ts),
// so the buttons only open it. The primary
// checkout can be mirrored but not transplanted: it is the project
// itself and cannot be torn down.
import { useState } from "react";
import { RefreshCw, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import {
  useLocalMirrorBlocker,
  useWorktreeMirrorLinks,
} from "@/hooks/remote/useMirrors";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { FooterActionButton } from "./FooterActionButton";
import { usePeerTargets } from "./flow/peerTargets";
import { MirrorToDialog } from "./mirror/MirrorDialog";
import { TransplantToDialog } from "./transplant/TransplantDialog";

export function PeerTransferActions({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  if (
    worktree.detached ||
    !isRealBranch(worktree.branch) ||
    project.identity == null
  ) {
    return null;
  }
  return (
    <TransferButtons
      worktree={worktree}
      project={project}
      sourceIdentity={project.identity}
    />
  );
}

function TransferButtons({
  worktree,
  project,
  sourceIdentity,
}: {
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
}) {
  const [open, setOpen] = useState<"mirror" | "transplant" | null>(null);
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
  if (!canOpen && open === null) return null;
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
        <FooterActionButton
          icon={<RefreshCw />}
          label="Mirror to…"
          title="Keep a live copy of this worktree on another device"
          disabledReason={mirrorBlocker}
          onClick={() => setOpen("mirror")}
        />
      )}
      {canOpen && !worktree.isPrimary && (
        <FooterActionButton
          icon={<Shovel />}
          label="Transplant to…"
          title="Move this worktree to another device"
          onClick={() => setOpen("transplant")}
        />
      )}
      {open === "mirror" && <MirrorToDialog {...dialog} />}
      {open === "transplant" && <TransplantToDialog {...dialog} />}
    </>
  );
}
