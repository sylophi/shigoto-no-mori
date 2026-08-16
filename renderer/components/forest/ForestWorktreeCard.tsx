import { BranchLabel } from "@/components/ui/branch-label";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { ActivityIcon } from "@/components/sidebar/ActivityIcon";
import { PullRequestPill } from "@/components/sidebar/PullRequestPill";
import {
  ChangedFilesPill,
  RemoteSyncPill,
} from "@/components/sidebar/StatusIndicator";
import { useWorktreeRowState } from "@/components/sidebar/useWorktreeRowState";
import { formatDuration, formatRelativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import type { ForestEntry } from "./forestFilters";

interface ForestWorktreeCardProps {
  entry: ForestEntry;
}

// One worktree as a two-line tile. Line one is identity plus the status
// cluster the sidebar already speaks (same components, so the two
// surfaces can't disagree). Line two is the context you'd otherwise
// have to open the worktree to see: folder, latest commit subject, and
// when things last happened.
export function ForestWorktreeCard({ entry }: ForestWorktreeCardProps) {
  const { worktree, pullRequest } = entry;
  const { isSelected, open, activity, isDeleting, title } =
    useWorktreeRowState(worktree);
  const commit = worktree.recentCommits[0];

  return (
    <button
      type="button"
      data-slot="forest-row"
      onClick={open}
      title={title}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        isSelected && "bg-accent text-accent-foreground",
        worktree.shelved && "opacity-60",
        isDeleting && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <BranchLabel
            branch={worktree.branch}
            detached={worktree.detached}
            suffixClassName="text-[10px]"
          />
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {isDeleting ? (
            <ActivityIcon kind="teardown" />
          ) : (
            <>
              {activity && <ActivityIcon kind={activity} />}
              {/* Both pills, not the sidebar's either/or: on this screen
                  "dirty AND 2 ahead" is the thing you're surveying for. */}
              <ChangedFilesPill worktree={worktree} />
              <RemoteSyncPill worktree={worktree} />
              <PullRequestPill pr={pullRequest} showNumber />
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <WorktreeKindIcon worktree={worktree} showTooltip={false} />
        {/* Capped rather than flexible: the folder name is the row's
            second identity, so it holds its width and lets the commit
            subject give ground first. */}
        <span className="max-w-48 shrink-0 truncate">{worktree.name}</span>
        {commit && (
          <>
            <Separator />
            <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
          </>
        )}
        <span className="tabular ml-auto flex shrink-0 items-center gap-1.5">
          {entry.lastCommitAt !== null && (
            <span title="Last commit">
              {formatRelativeTime(entry.lastCommitAt)}
            </span>
          )}
          {worktree.createdAt !== undefined && (
            <>
              {/* Only a separator when there's a timestamp to its left --
                  a branch with no commits shows the age on its own. */}
              {entry.lastCommitAt !== null && <Separator />}
              <span title="Worktree age">
                {formatDuration(Date.now() - worktree.createdAt)} old
              </span>
            </>
          )}
        </span>
      </div>
    </button>
  );
}

function Separator() {
  return (
    <span aria-hidden className="shrink-0 opacity-50">
      ·
    </span>
  );
}
