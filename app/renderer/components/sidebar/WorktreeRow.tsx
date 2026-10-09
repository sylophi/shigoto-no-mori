// A worktree's row in the sidebar tree (WorktreeRowView), this
// machine's or a peer's. A peer's row takes the local row's own rule,
// scoped to the device: the open remote worktree reads as selected
// like a local one.
import { useWorktreeEntry } from "./useWorktreeEntry";
import { type WorktreeRowProps, WorktreeRowView } from "./WorktreeRowView";

export function WorktreeRow({ mirrorWorktreeId, ...props }: WorktreeRowProps) {
  const entry = useWorktreeEntry(props.worktree, props.device, {
    deviceId: props.mirror?.deviceId,
    worktreeId: mirrorWorktreeId,
  });
  return <WorktreeRowView {...props} entry={entry} />;
}
