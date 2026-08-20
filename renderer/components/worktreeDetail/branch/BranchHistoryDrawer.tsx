import { useEffect, useRef, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useBranchCommits } from "@/hooks/git/useBranchCommits";
import type { CommitSummary, Worktree } from "@shared/schemas";
import { CommitRow } from "../commits/CommitRow";

interface BranchHistoryDrawerProps {
  worktree: Worktree;
  open: boolean;
  onClose: () => void;
}

// Approximate height of a CommitRow + spacing in the list. Used as the
// virtualizer's size hint -- it remeasures real rows on mount, so this
// only needs to be in the right ballpark.
const ROW_ESTIMATE = 60;

// How many rows from the bottom of the rendered window trigger the next
// page fetch. Five gives a comfortable head-start on scroll.
const FETCH_AHEAD = 5;

export function BranchHistoryDrawer({
  worktree,
  open,
  onClose,
}: BranchHistoryDrawerProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[360px]"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Branch history
          </SheetTitle>
          <SheetDescription className="truncate font-mono text-sm text-foreground">
            {worktree.branch}
          </SheetDescription>
        </SheetHeader>

        {/* Inner list lives in its own component so it remounts on each
        open. Without this, the virtualizer's resize/scroll observers
        stay attached to the previous (unmounted) DOM node and render
        an empty window. */}
        <BranchHistoryList worktree={worktree} onNavigate={onClose} />
      </SheetContent>
    </Sheet>
  );
}

interface BranchHistoryListProps {
  worktree: Worktree;
  onNavigate: () => void;
}

function BranchHistoryList({ worktree, onNavigate }: BranchHistoryListProps) {
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    isLoading,
    isError,
    error,
    refetch,
  } = useBranchCommits(
    worktree.projectId,
    worktree.id,
    worktree.recentCommits[0]?.hash,
    true,
  );

  const commits = data ? data.pages.flat() : [];
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Loading commits…
        </div>
      ) : isError ? (
        <div className="space-y-2 py-6 text-sm">
          <div className="text-destructive select-text">
            {error?.message ?? "Couldn't load branch history."}
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Retry
          </button>
        </div>
      ) : commits.length === 0 ? (
        <div className="py-6 text-sm text-muted-foreground">
          No commits yet.
        </div>
      ) : (
        <VirtualCommitList
          commits={commits}
          containerRef={containerRef}
          worktree={worktree}
          onNavigate={onNavigate}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          fetchNextPage={fetchNextPage}
        />
      )}
      {isFetchingNextPage && (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          Loading more…
        </div>
      )}
      {!hasNextPage && !isLoading && commits.length > 0 && (
        <div className="py-3 text-center text-[11px] text-muted-foreground/60">
          End of history
        </div>
      )}
    </div>
  );
}

// Split out for the same reason as SidebarList: keeping useVirtualizer
// in a leaf lets the parent (which re-flattens the whole loaded
// history) stay memoized.
function VirtualCommitList({
  commits,
  containerRef,
  worktree,
  onNavigate,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  commits: CommitSummary[];
  containerRef: RefObject<HTMLDivElement | null>;
  worktree: Worktree;
  onNavigate: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}) {
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => commits[index]?.hash ?? index,
  });

  // Trigger the next page as soon as the bottom-most rendered item is
  // within FETCH_AHEAD of the loaded list end. Reading from the
  // virtualizer instead of an IntersectionObserver keeps the trigger in
  // sync with the rows the user is actually seeing.
  const items = virtualizer.getVirtualItems();
  const lastVisibleIndex =
    items.length === 0 ? -1 : items[items.length - 1]!.index;
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    if (lastVisibleIndex < 0) return;
    if (lastVisibleIndex >= commits.length - 1 - FETCH_AHEAD) {
      void fetchNextPage();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    lastVisibleIndex,
    commits.length,
    fetchNextPage,
  ]);

  return (
    <div
      className="relative"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {items.map((vi) => {
        const commit = commits[vi.index];
        if (!commit) return null;
        return (
          <div
            key={commit.hash}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${vi.start}px)` }}
          >
            <CommitRow
              worktree={worktree}
              commit={commit}
              onNavigate={onNavigate}
            />
          </div>
        );
      })}
    </div>
  );
}
