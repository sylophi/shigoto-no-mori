import { ChevronRight } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { DiffStats } from "@/components/ui/diff-stats";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { CommitSummary, Worktree } from "@shared/schemas";

interface CommitRowProps {
  worktree: Worktree;
  commit: CommitSummary;
  onNavigate?: () => void;
}

export function CommitRow({ worktree, commit, onNavigate }: CommitRowProps) {
  const navigate = useNavigate();
  const onClick = () => {
    onNavigate?.();
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/commits/$hash",
      params: {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        hash: commit.hash,
      },
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="View this commit's diff"
      className="-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="w-full truncate text-sm">{commit.subject}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{commit.hash}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span>{commit.author}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <RelativeDate date={commit.date} />
        </div>
      </div>
      {(commit.additions > 0 || commit.deletions > 0) && (
        <DiffStats additions={commit.additions} deletions={commit.deletions} />
      )}
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/40"
      />
    </button>
  );
}

function RelativeDate({ date }: { date: string }) {
  const value = new Date(date);
  return (
    <span title={value.toLocaleString()}>
      {formatRelativeTime(value.getTime())}
    </span>
  );
}
