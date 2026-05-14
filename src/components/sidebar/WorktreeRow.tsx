import { ExternalLink, House } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/types";

interface WorktreeRowProps {
  worktree: Worktree;
}

export function WorktreeRow({ worktree }: WorktreeRowProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const expectedPath = `/projects/${encodeURIComponent(worktree.projectId)}/worktrees/${encodeURIComponent(worktree.name)}`;
  const isSelected = location.pathname === expectedPath;

  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/projects/$projectId/worktrees/$worktreeName",
          params: {
            projectId: worktree.projectId,
            worktreeName: worktree.name,
          },
        })
      }
      title={
        worktree.isPrimary
          ? "Primary checkout"
          : worktree.isExternal
            ? `External worktree at ${worktree.path}`
            : undefined
      }
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
        "hover:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate font-mono",
            isSelected && "font-medium",
          )}
        >
          {worktree.branch}
        </span>
        <span className="truncate text-[10px] text-muted-foreground capitalize">
          {worktree.name}
        </span>
      </div>
      {worktree.isPrimary && (
        <House
          className="size-3 text-muted-foreground/60"
          aria-label="Primary checkout"
        />
      )}
      {!worktree.isPrimary && worktree.isExternal && (
        <ExternalLink
          className="size-3 text-muted-foreground/60"
          aria-label="External worktree"
        />
      )}
      <StatusIndicator worktree={worktree} />
    </button>
  );
}

function StatusIndicator({ worktree }: { worktree: Worktree }) {
  const parts: string[] = [];
  if (worktree.ahead > 0) parts.push(`↑${worktree.ahead}`);
  if (worktree.behind > 0) parts.push(`↓${worktree.behind}`);
  if (worktree.dirtyCount > 0) parts.push(`●${worktree.dirtyCount}`);

  if (parts.length === 0) {
    return null;
  }

  return (
    <span className="tabular text-[10px] text-muted-foreground">
      {parts.join(" ")}
    </span>
  );
}
