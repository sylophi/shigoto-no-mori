import { useState, type ReactNode } from "react";
import { ChevronRight, GitFork, Layers, Search } from "lucide-react";
import { BranchBar } from "@/components/diff/BranchBar";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/ui/useDebouncedValue";
import {
  useBranchCommits,
  useBranchHistory,
} from "@/hooks/git/useBranchCommits";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { commitRewriteAt, NO_REWRITE } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import type { CommitSummary, Worktree } from "@shared/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { CommitRow, HistorySelection, useRowSelection } from "./CommitRow";
import { useCommitActions, type CommitActions } from "./useCommitActions";

// The Git page's History tab, laid out like its Stashes tab: a search
// field, then one kind of row under plain headings. First the branch's
// whole diff, then its commits, newest first, split where the remote's
// copy of the branch stands (Not pushed, Pushed), then, folded, the
// history before the branch. The moves on the branch as a whole (push,
// sync from the primary branch) sit in the footer, where the Changes
// tab keeps them.
export function HistoryList({
  worktree,
  selected,
}: {
  worktree: Worktree;
  // `branch` or `commit:<hash>`: what the page shows.
  selected: string | null;
}) {
  const actions = useCommitActions(worktree);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 250);

  return (
    <HistorySelection value={selected}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative px-2 pb-2">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4.5 -mt-1 size-3.5 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.stopPropagation();
                setSearch("");
              }
            }}
            placeholder="Search commit messages"
            aria-label="Search commit messages"
            spellCheck={false}
            className="w-full py-1.5 pr-2.5 pl-7 text-xs"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {query ? (
            <SearchResults
              worktree={worktree}
              query={query}
              actions={actions}
            />
          ) : (
            <BranchCommits worktree={worktree} actions={actions} />
          )}
        </div>
        <HistoryFooter worktree={worktree} />
        {actions.dialog}
      </div>
    </HistorySelection>
  );
}

function BranchCommits({
  worktree,
  actions,
}: {
  worktree: Worktree;
  actions: CommitActions;
}) {
  const { data: history } = useBranchHistory(
    worktree.projectId,
    worktree.id,
    worktree.recentCommits[0]?.hash,
  );
  const [earlierOpen, setEarlierOpen] = useState(false);
  if (!history) {
    return <Note>Reading the history…</Note>;
  }
  const own = history.commits;
  const base = history.base;
  // The newest `unpushedCount` are on no remote yet.
  const split = Math.min(worktree.unpushedCount, own.length);
  const row = (commit: CommitSummary, index: number) => (
    <CommitRow
      key={commit.hash}
      worktree={worktree}
      commit={commit}
      rewrite={commitRewriteAt(worktree, own, index)}
      actions={actions}
    />
  );
  // Past what the history read holds: past a branch longer than the
  // read, from its oldest commit shown, else from where the branch left
  // the primary branch. Without one (the primary checkout), only when
  // there is more than the read held.
  const earlierFrom = history.more ? own.at(-1)?.hash : base?.hash;
  return (
    <>
      {base && own.length > 0 && (
        <BranchChangesRow
          worktree={worktree}
          base={base.ref}
          own={own.length}
          more={history.more}
        />
      )}
      {split > 0 && (
        <Group label="Not pushed" count={split}>
          {own.slice(0, split).map(row)}
        </Group>
      )}
      {own.length > split && (
        <Group label="Pushed" count={own.length - split}>
          {own.slice(split).map((commit, i) => row(commit, split + i))}
        </Group>
      )}
      {earlierFrom && (
        <>
          <button
            type="button"
            aria-expanded={earlierOpen}
            onClick={() => setEarlierOpen((open) => !open)}
            className="group/earlier flex w-full items-center gap-1 px-2 pt-3 pb-1 text-left"
          >
            <GroupLabel>
              {base && !history.more ? "Before this branch" : "Older"}
            </GroupLabel>
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground transition-transform group-hover/earlier:text-foreground",
                earlierOpen && "rotate-90",
              )}
            />
          </button>
          {earlierOpen && (
            <EarlierCommits
              worktree={worktree}
              from={earlierFrom}
              shown={own}
              actions={actions}
            />
          )}
        </>
      )}
    </>
  );
}

// The branch's whole diff, picked like a commit. How far the primary
// branch has moved on since is the footer's to say, beside its sync.
function BranchChangesRow({
  worktree,
  base,
  own,
  more,
}: {
  worktree: Worktree;
  base: string;
  own: number;
  more: boolean;
}) {
  const nav = useWorktreeNav();
  const selected = useRowSelection("branch");
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={() => nav.toBranchDiff(worktree.projectId, worktree.id, true)}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <Layers
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">All branch changes</span>
        <span className="block truncate text-xs text-muted-foreground">
          {more ? `${own}+ commits` : pluralize(own, "commit")} since {base}
        </span>
      </span>
    </button>
  );
}

// The commits before what the branch's list shows, faded: the primary
// branch's, which nothing here rewrites. Paged in on request.
function EarlierCommits({
  worktree,
  from,
  shown,
  actions,
}: {
  worktree: Worktree;
  from: string;
  // Already listed above, left out here.
  shown: readonly CommitSummary[];
  actions: CommitActions;
}) {
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useBranchCommits(
      worktree.projectId,
      worktree.id,
      worktree.recentCommits[0]?.hash,
      true,
      { from },
    );
  const listed = new Set(shown.map((c) => c.hash));
  const commits = (data ? data.pages.flat() : []).filter(
    (c) => !listed.has(c.hash),
  );
  return (
    <PastCommits
      worktree={worktree}
      commits={commits}
      actions={actions}
      faded
      more={
        hasNextPage
          ? { pending: isFetchingNextPage, load: () => void fetchNextPage() }
          : null
      }
    />
  );
}

function SearchResults({
  worktree,
  query,
  actions,
}: {
  worktree: Worktree;
  query: string;
  actions: CommitActions;
}) {
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useBranchCommits(
      worktree.projectId,
      worktree.id,
      worktree.recentCommits[0]?.hash,
      true,
      { query },
    );
  const commits = data ? data.pages.flat() : [];
  if (isLoading) return <Note>Searching…</Note>;
  if (commits.length === 0) return <Note>No commit messages match.</Note>;
  return (
    <PastCommits
      worktree={worktree}
      commits={commits}
      actions={actions}
      more={
        hasNextPage
          ? { pending: isFetchingNextPage, load: () => void fetchNextPage() }
          : null
      }
    />
  );
}

// Commits off the branch's own list (a search's, the history before
// it), each with the moves that only add commits.
function PastCommits({
  worktree,
  commits,
  actions,
  faded = false,
  more,
}: {
  worktree: Worktree;
  commits: readonly CommitSummary[];
  actions: CommitActions;
  faded?: boolean;
  more: { pending: boolean; load: () => void } | null;
}) {
  return (
    <>
      {commits.map((commit) => (
        <CommitRow
          key={commit.hash}
          worktree={worktree}
          commit={commit}
          rewrite={NO_REWRITE}
          actions={actions}
          faded={faded}
        />
      ))}
      {more && (
        <button
          type="button"
          disabled={more.pending}
          onClick={more.load}
          className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {more.pending ? "Loading…" : "Show more"}
        </button>
      )}
    </>
  );
}

// The tab's foot, as the Changes tab's: the branch and what the remote
// is owed, and when the primary branch has moved on, how far, with the
// sync (held while there are uncommitted changes).
function HistoryFooter({ worktree }: { worktree: Worktree }) {
  const behind = worktree.behindPrimary;
  const primary = worktree.primaryRef;
  const showPrimary =
    !worktree.isPrimary && !worktree.detached && behind > 0 && primary;
  return (
    <div className="flex flex-col border-t border-border pt-1 pb-2">
      <BranchBar worktree={worktree} />
      {showPrimary && (
        <div className="flex h-7 items-center gap-2 px-3">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <GitFork aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">
              {behind} behind {primary}
            </span>
          </span>
          <WorktreePrimarySyncPill
            worktree={worktree}
            label="Sync"
            disabledReason={
              worktree.changedCount > 0
                ? "Commit or stash your changes first"
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

function Group({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-1.5 px-2 pt-3 pb-1">
        <GroupLabel>{label}</GroupLabel>
        <span className="tabular text-2xs text-muted-foreground">{count}</span>
      </div>
      {children}
    </section>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-xs text-muted-foreground">{children}</p>
  );
}
