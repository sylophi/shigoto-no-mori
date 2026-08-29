// A peer device's worktree in the sidebar tree: the local WorktreeRow's
// layout (branch over name, trailing status cluster) with the local-only
// concerns dropped -- no script activity, deletion state or PR pill,
// which all read this machine's stores -- and a device marker in their
// place. Opens the device's forest page, the one surface a remote
// worktree has.
import { useNavigate } from "@tanstack/react-router";
import { MonitorSmartphone } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { StatusIndicator } from "./StatusIndicator";
import { WORKTREE_ROW_BUTTON, WorktreeRowLabel } from "./WorktreeRow";

interface RemoteWorktreeRowProps {
  worktree: Worktree;
  deviceId: string;
  deviceLabel: string;
}

export function RemoteWorktreeRow({
  worktree,
  deviceId,
  deviceLabel,
}: RemoteWorktreeRowProps) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({ to: "/devices/$deviceId", params: { deviceId } })
      }
      className={WORKTREE_ROW_BUTTON}
    >
      <WorktreeRowLabel worktree={worktree} />
      <StatusIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
      {/* Rightmost, same shape as WorktreeKindIcon: a neutral marker
          whose device name lives in the tooltip, not the row. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex shrink-0">
              <MonitorSmartphone
                aria-label={`On ${deviceLabel}`}
                className="size-3 text-muted-foreground/70"
              />
            </span>
          }
        />
        <TooltipContent>On {deviceLabel}</TooltipContent>
      </Tooltip>
    </button>
  );
}
