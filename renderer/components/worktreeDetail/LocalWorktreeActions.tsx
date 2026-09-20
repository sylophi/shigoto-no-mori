// This device's own worktree footer verbs, in the spots the remote
// footer gives its Ports, Mirror and Transplant buttons.
import type { Project, Worktree } from "@shared/schemas";
import { LocalMirrorAction } from "./mirror/LocalMirrorAction";
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
      <PortsButton worktree={worktree} />
      <LocalMirrorAction worktree={worktree} />
      <PeerTransferActions worktree={worktree} project={project} />
    </>
  );
}
