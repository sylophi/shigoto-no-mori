import type { SidebarDeviceBadge } from "./DeviceBadge";
import type { GroupShelf } from "./sidebarRow";
import type { PullRequest, Worktree } from "@shared/schemas";
import type { StackChild, StackPosition } from "@shared/pullRequestStack";
import { useWorktreeEntry } from "./useWorktreeEntry";
import { useWorktreeRowState } from "./useWorktreeRowState";
import { WorktreeRowView } from "./WorktreeRowView";

interface WorktreeRowProps {
  worktree: Worktree;
  // The peer device a peer's worktree lives on, for its badge beside
  // the worktree's name. Absent, the worktree is this machine's.
  device?: SidebarDeviceBadge;
  // The peer this worktree is mirrored with, when it is: the row then
  // stands for both copies and wears the peer's badge.
  mirror?: SidebarDeviceBadge;
  pr: PullRequest | undefined;
  // Both off the tree builder, which places the project's rows by
  // stack once (buildSidebarRows).
  stack: StackPosition | null;
  stackChild?: StackChild;
  shelf: GroupShelf | null;
}

// A worktree in the sidebar tree (WorktreeRowView), with its state and
// what its row looks up.
export function WorktreeRow({
  worktree,
  device,
  mirror,
  pr,
  stack,
  stackChild,
  shelf,
}: WorktreeRowProps) {
  // A peer's row takes the local row's own rule, scoped to the device:
  // the open remote worktree reads as selected like a local one.
  const state = useWorktreeRowState(worktree, device?.deviceId);
  const entry = useWorktreeEntry(worktree, device?.deviceId);
  return (
    <WorktreeRowView
      worktree={worktree}
      pr={pr}
      stack={stack}
      stackChild={stackChild}
      device={device}
      mirror={mirror}
      look={state}
      shelf={shelf}
      onClick={state.open}
      {...entry}
    />
  );
}
