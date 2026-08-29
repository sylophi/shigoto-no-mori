// A peer device's worktree in the sidebar tree: the local WorktreeRow's
// layout (branch over name, trailing status cluster) with the local-only
// concerns dropped -- no script activity, deletion state or PR pill,
// which all read this machine's stores -- and a device badge in their
// place. Opens the worktree's own detail page under the device-scoped
// twin route, exactly like clicking a local row. An unreachable
// device's rows fade back: last known state, not an error.
import { useNavigate } from "@tanstack/react-router";
import type { Worktree } from "@shared/schemas";
import { cn } from "@/lib/utils";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { DeviceBadge } from "./DeviceBadge";
import { StatusIndicator } from "./StatusIndicator";
import { WORKTREE_ROW_BUTTON, WorktreeRowLabel } from "./WorktreeRow";

interface RemoteWorktreeRowProps {
  worktree: Worktree;
  deviceId: string;
  deviceLabel: string;
  reachable: boolean;
}

export function RemoteWorktreeRow({
  worktree,
  deviceId,
  deviceLabel,
  reachable,
}: RemoteWorktreeRowProps) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/devices/$deviceId/projects/$projectId/worktrees/$worktreeId",
          params: {
            deviceId,
            projectId: worktree.projectId,
            worktreeId: worktree.id,
          },
        })
      }
      className={cn(WORKTREE_ROW_BUTTON, !reachable && "opacity-60")}
    >
      <WorktreeRowLabel worktree={worktree} />
      <StatusIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
      {/* Rightmost, where the local row keeps its own trailing cluster:
          the owning device, name in the tooltip. */}
      <DeviceBadge badge={{ deviceId, label: deviceLabel, reachable }} />
    </button>
  );
}
