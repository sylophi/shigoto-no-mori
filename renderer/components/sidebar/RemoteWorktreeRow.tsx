// A peer device's worktree in the sidebar tree: the local WorktreeRow's
// layout (branch over name, trailing status cluster) with the concerns
// that read this machine's stores dropped -- no deletion state or PR
// pill -- and a device badge in their place. Script activity stays: a
// run dispatched to the peer from here lives in that device's own run
// store, so the row shows it like a local row does. Opens the
// worktree's own detail page under the device-scoped twin route,
// exactly like clicking a local row. An unreachable device's rows fade
// back: last known state, not an error.
import type { Worktree } from "@shared/schemas";
import type { StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { ActivityIcon } from "./ActivityIcon";
import { DeviceBadge } from "./DeviceBadge";
import { StatusIndicator } from "./StatusIndicator";
import { useWorktreeRowState } from "./useWorktreeRowState";
import { WORKTREE_ROW_BUTTON, WorktreeRowLabel } from "./WorktreeRow";

interface RemoteWorktreeRowProps {
  worktree: Worktree;
  deviceId: string;
  deviceLabel: string;
  reachable: boolean;
  tone: StatusTone;
}

export function RemoteWorktreeRow({
  worktree,
  deviceId,
  deviceLabel,
  reachable,
  tone,
}: RemoteWorktreeRowProps) {
  // The local row's own rule, scoped to the device: the open remote
  // worktree reads as selected like a local one.
  const { isSelected, open, activity, title } = useWorktreeRowState(
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
        !reachable && "opacity-60",
      )}
    >
      <WorktreeRowLabel worktree={worktree} emphasized={isSelected} />
      {activity && <ActivityIcon kind={activity} />}
      <StatusIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
      {/* Rightmost, where the local row keeps its own trailing cluster:
          the owning device, name in the tooltip. */}
      <DeviceBadge badge={{ deviceId, label: deviceLabel, tone, reachable }} />
    </button>
  );
}
