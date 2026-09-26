// This device's own worktree footer verbs, in the spots the remote
// footer gives its Files, Ports, Mirror and Transplant buttons.
import type { Project, Worktree } from "@shared/schemas";
import { FilesButton } from "./FilesButton";
import { MirrorAction } from "./mirror/MirrorAction";
import { PeerTransferActions } from "./PeerTransferActions";
import { PortsButton } from "./ports/PortsButton";

export function LocalWorktreeActions({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  return (
    <>
      <FilesButton worktree={worktree} />
      <PortsButton worktree={worktree} />
      <MirrorAction worktree={worktree} />
      <PeerTransferActions worktree={worktree} project={project} />
    </>
  );
}
