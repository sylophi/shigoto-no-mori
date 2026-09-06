// A peer device's worktree in the sidebar tree: the local WorktreeRow's
// layout (branch over name, trailing status cluster) plus a device
// badge at the trailing edge. Everything else reads as local: the PR
// pill off the peer's own map, a delete dispatched to the peer from
// here off that device's mutation, script activity off its run store.
// Opens the worktree's own detail page under the device-scoped twin
// route, exactly like clicking a local row. An unreachable device's
// rows fade back: last known state, not an error.
import type { PullRequest, Worktree } from "@shared/schemas";
import type { StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { DeviceBadge } from "./DeviceBadge";
import { useWorktreeRowState } from "./useWorktreeRowState";
import {
  RowTrailing,
  WORKTREE_ROW_BUTTON,
  WorktreeRowLabel,
} from "./WorktreeRow";

interface RemoteWorktreeRowProps {
  worktree: Worktree;
  deviceId: string;
  deviceLabel: string;
  reachable: boolean;
  tone: StatusTone;
  pr: PullRequest | undefined;
}

export function RemoteWorktreeRow({
  worktree,
  deviceId,
  deviceLabel,
  reachable,
  tone,
  pr,
}: RemoteWorktreeRowProps) {
  // The local row's own rule, scoped to the device: the open remote
  // worktree reads as selected like a local one.
  const { isSelected, open, activity, isDeleting, title } = useWorktreeRowState(
    worktree,
    deviceId,
  );
  return (
    <button
      type="button"
      onClick={open}
      title={title}
      className={cn(
        WORKTREE_ROW_BUTTON,
        isSelected && "bg-accent text-accent-foreground",
        (isDeleting || !reachable) && "opacity-60",
      )}
    >
      <WorktreeRowLabel worktree={worktree} emphasized={isSelected} />
      <RowTrailing
        worktree={worktree}
        activity={activity}
        isDeleting={isDeleting}
        pr={pr}
      />
      {/* Rightmost, where the local row keeps its own trailing cluster:
          the owning device, name in the tooltip. */}
      <DeviceBadge badge={{ deviceId, label: deviceLabel, tone, reachable }} />
    </button>
  );
}
