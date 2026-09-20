// The local worktree footer's ways out to another of the account's
// devices, the remote footer's "Mirror here" and "Transplant here"
// turned around: a live copy of this worktree on a peer ("Mirror
// to…"), or moving it there ("Transplant to…"). Both wait on what the
// remote pair waits on (a real branch of its own, a repo identity) and
// on a peer holding the same repo. Which peer is the dialog's question
// (flow/peerTargets.ts), so the buttons only open it.
import { useState } from "react";
import { RefreshCw, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { useWorktreeMirror } from "@/hooks/remote/useMirrors";
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
    worktree.isPrimary ||
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
  // A worktree already running a mirror has its Mirror button beside
  // these (LocalMirrorAction), which is where that one is managed.
  const mirrored = useWorktreeMirror(worktree).session !== undefined;
  if (targets.length === 0) return null;
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
      {canForwardPorts && !mirrored && (
        <FooterActionButton
          icon={<RefreshCw />}
          label="Mirror to…"
          title="Keep a live copy of this worktree on another device"
          onClick={() => setOpen("mirror")}
        />
      )}
      <FooterActionButton
        icon={<Shovel />}
        label="Transplant to…"
        title="Move this worktree to another device"
        onClick={() => setOpen("transplant")}
      />
      {open === "mirror" && <MirrorToDialog {...dialog} />}
      {open === "transplant" && <TransplantToDialog {...dialog} />}
    </>
  );
}
