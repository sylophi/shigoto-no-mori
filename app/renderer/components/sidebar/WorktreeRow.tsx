// A worktree's row in the sidebar tree (WorktreeRowView), this
// machine's or a peer's, with the worktree's menu on a right click
// (WorktreeMenu). A peer's row takes the local row's own rule, scoped
// to the device: the open remote worktree reads as selected like a
// local one.
import { useWorktreeEntry } from "./useWorktreeEntry";
import { WorktreeMenu } from "./WorktreeMenu";
import {
  type WorktreeRowProps,
  WorktreeRowView,
} from "@shigomori/ui/views/sidebar/WorktreeRowView.tsx";

export function WorktreeRow({ mirrorWorktreeId, ...props }: WorktreeRowProps) {
  const entry = useWorktreeEntry(props.worktree, props.device, {
    deviceId: props.mirror?.deviceId,
    worktreeId: mirrorWorktreeId,
  });
  return (
    <WorktreeMenu
      worktree={props.worktree}
      pr={props.pr}
      deviceId={props.device?.deviceId}
      row={<WorktreeRowView {...props} entry={entry} />}
    />
  );
}
