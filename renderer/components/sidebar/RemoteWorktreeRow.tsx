// A peer device's worktree in the sidebar tree: the local WorktreeRow's
// layout (branch over name, trailing status cluster) with the local-only
// concerns dropped -- no script activity, deletion state or PR pill,
// which all read this machine's stores -- and a device marker in their
// place. Opens the device's forest page, the one surface a remote
// worktree has.
import { useNavigate } from "@tanstack/react-router";
import { MonitorSmartphone } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { BranchLabel } from "@/components/ui/branch-label";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { StatusIndicator } from "./StatusIndicator";

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
      title={`On ${deviceLabel}`}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate font-mono"
          title={worktree.detached ? "Detached HEAD (commit hash)" : undefined}
        >
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {worktree.name}
        </span>
      </div>
      <StatusIndicator worktree={worktree} />
      <span
        aria-label={`On ${deviceLabel}`}
        className="inline-flex max-w-24 shrink-0 items-center gap-0.5 text-[10px] text-sky-500"
      >
        <MonitorSmartphone aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{deviceLabel}</span>
      </span>
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
    </button>
  );
}
