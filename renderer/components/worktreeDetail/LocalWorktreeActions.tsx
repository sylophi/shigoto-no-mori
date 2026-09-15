// This device's own worktree footer verbs, in the spots the remote
// footer gives its Ports and Mirror buttons.
import type { Worktree } from "@shared/schemas";
import { LocalMirrorAction } from "./mirror/LocalMirrorAction";
import { PortsButton } from "./ports/PortsButton";

export function LocalWorktreeActions({ worktree }: { worktree: Worktree }) {
  return (
    <>
      <PortsButton worktree={worktree} />
      <LocalMirrorAction worktree={worktree} />
    </>
  );
}
