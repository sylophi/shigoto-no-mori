// The Branch section as drawn (CommitsSection.tsx feeds it): the
// heading with the uncommitted changes or the sync pill
// (WorktreeSyncPillView) beside it, the newest commits, and under them the catch-up pill
// (WorktreePrimarySyncPillView) and Show all.
import type { ReactNode } from "react";
import { ChevronRight, FileDiff, History } from "lucide-react";
import { SectionHeading } from "@/components/ui/section-heading";
import type { CommitSummary } from "@shared/schemas";

export function CommitsSectionView({
  changedCount,
  syncPill,
  commits,
  renderCommit,
  primarySync,
  showAll = false,
  onOpenChanges,
  onShowAll,
  drawer,
}: {
  // Uncommitted files, which take the sync pill's place.
  changedCount: number;
  syncPill?: ReactNode;
  // The teaser's commits, newest first.
  commits: CommitSummary[];
  // A commit's row: CommitRow, or CommitRowView for a picture of it.
  renderCommit: (commit: CommitSummary, index: number) => ReactNode;
  primarySync?: ReactNode;
  // More commits than the teaser shows.
  showAll?: boolean;
  onOpenChanges?: () => void;
  onShowAll?: () => void;
  // The full history's drawer.
  drawer?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      {/* Held at the heading's height: the sync and changes buttons
          overhang it, so the commits don't shift when one appears. */}
      <div className="flex h-4 items-center justify-between gap-2">
        <SectionHeading>Branch</SectionHeading>
        {changedCount > 0 ? (
          <button
            type="button"
            onClick={onOpenChanges}
            title="Review, commit or discard the uncommitted changes"
            className="tabular inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-amber-500 transition-colors hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FileDiff aria-hidden className="size-3.5" />
            {changedCount} {changedCount === 1 ? "file" : "files"} changed
            <ChevronRight aria-hidden className="size-3.5 opacity-60" />
          </button>
        ) : (
          syncPill
        )}
      </div>
      {commits.length === 0 ? (
        <div className="text-sm text-muted-foreground">No commits yet.</div>
      ) : (
        <ul className="space-y-2">
          {commits.map((commit, index) => (
            <li key={commit.hash}>{renderCommit(commit, index)}</li>
          ))}
        </ul>
      )}
      {(primarySync || showAll) && (
        <div className="flex items-center gap-2">
          {primarySync}
          {showAll && (
            <button
              type="button"
              onClick={onShowAll}
              title="Browse full branch history"
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <History aria-hidden className="size-3.5" />
              Show all
              <ChevronRight aria-hidden className="size-3.5 opacity-60" />
            </button>
          )}
        </div>
      )}
      {drawer}
    </section>
  );
}
