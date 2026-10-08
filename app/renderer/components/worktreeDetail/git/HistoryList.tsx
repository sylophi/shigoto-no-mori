import { useState, type ReactNode } from "react";
import {
  ChevronRight,
  Cloud,
  CloudOff,
  GitFork,
  Layers,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/hooks/ui/useDebouncedValue";
import {
  useBranchCommits,
  useBranchHistory,
} from "@/hooks/git/useBranchCommits";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { commitRewriteAt, NO_REWRITE } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  deriveRemoteSyncState,
  type CommitSummary,
  type Worktree,
} from "@shared/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { CommitRow, HistorySelection, useRowSelection } from "./CommitRow";
import { useCommitActions, type CommitActions } from "./useCommitActions";

// The Git page's History tab: a search field, the branch's whole diff,
// then its commits, newest first, with the refs that matter drawn as
// lines across the list where they point. The remote's copy of the
// branch sits under the commits it doesn't have yet, with the push, and
// the primary branch where the branch began, with the sync. Under that,
// folded, the history before the branch.
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
  const remote = remoteLine(worktree, history.upstream, own.length);
  // Past what the history read holds: past a branch longer than the
  // read, from its oldest commit shown, else from where the branch left
  // the primary branch. Without one (the primary checkout), only when
  // there is more than the read held.
  const earlierFrom = history.more ? own.at(-1)?.hash : base?.hash;

  const rows: ReactNode[] = [];
  own.forEach((commit, index) => {
    if (remote?.at === index) rows.push(remote.line);
    rows.push(
      <CommitRow
        key={commit.hash}
        worktree={worktree}
        commit={commit}
        rewrite={commitRewriteAt(worktree, own, index)}
        actions={actions}
      />,
    );
  });
  if (remote && remote.at >= own.length) rows.push(remote.line);
  if (base) {
    rows.push(<BaseLine key="base" worktree={worktree} base={base.ref} />);
  }

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
      {rows}
      {earlierFrom && (
        <>
          <button
            type="button"
            aria-expanded={earlierOpen}
            onClick={() => setEarlierOpen((open) => !open)}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Earlier commits
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 transition-transform",
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

// Where the remote's copy of the branch stands among its commits, and
// the line that marks it there: under the commits it doesn't have yet,
// carrying the push (or pull). A branch on no remote yet gets a line
// above all of them instead, carrying the publish. None for a detached
// HEAD or a repo without a remote.
function remoteLine(
  worktree: Worktree,
  upstream: string | null,
  count: number,
): { at: number; line: ReactNode } | null {
  const state = deriveRemoteSyncState(worktree);
  if (state.kind === "detached") return null;
  const pill = <WorktreeSyncPill worktree={worktree} compact />;
  if (state.kind === "publish") {
    if (!state.canPublish) return null;
    return {
      at: 0,
      line: (
        <RefLine
          key="remote"
          icon={<CloudOff aria-hidden className="size-3.5" />}
          name="Local only"
          tip="On no remote yet: Publish puts it there"
          action={pill}
        />
      ),
    };
  }
  // Tracking a branch of its own name (the usual case), the remote's
  // name says it, as GitHub Desktop's "Push origin" does, and the
  // tooltip has it in full.
  const sameName =
    upstream?.endsWith(`/${worktree.branch}`) === true
      ? upstream.slice(0, -worktree.branch.length - 1)
      : null;
  return {
    at: Math.min(worktree.ahead, count),
    line: (
      <RefLine
        key="remote"
        icon={<Cloud aria-hidden className="size-3.5" />}
        name={sameName ?? upstream ?? "Remote"}
        mono={upstream !== null}
        tip={`${upstream ?? "The remote"} has everything from here down`}
        action={
          state.kind === "synced" ? (
            <span className="text-xs text-muted-foreground">Up to date</span>
          ) : (
            pill
          )
        }
      />
    ),
  };
}

// Where the branch left the primary branch, under the branch's own
// commits, carrying the sync once the primary branch has moved on (held
// while there are uncommitted changes, and saying why).
function BaseLine({ worktree, base }: { worktree: Worktree; base: string }) {
  const behind = worktree.behindPrimary;
  return (
    <RefLine
      icon={<GitFork aria-hidden className="size-3.5" />}
      name={base}
      mono
      tip={
        behind > 0
          ? `Where this branch began. ${base} has ${pluralize(behind, "new commit")} since.`
          : "Where this branch began"
      }
      action={
        behind > 0 && (
          <WorktreePrimarySyncPill
            worktree={worktree}
            label={`Sync ${behind}`}
            disabledReason={
              worktree.changedCount > 0
                ? "Commit or stash your changes first"
                : undefined
            }
          />
        )
      }
    />
  );
}

// A ref, drawn as a line across the list at the commit it points to,
// like a "new messages" line: its name, the rule, and its one move.
function RefLine({
  icon,
  name,
  mono = false,
  tip,
  action,
}: {
  icon: ReactNode;
  name: string;
  mono?: boolean;
  tip?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 px-2 py-1">
      <SimpleTooltip tip={tip ?? name}>
        <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">{icon}</span>
          <span className={cn("truncate", mono && "font-mono")}>{name}</span>
        </span>
      </SimpleTooltip>
      <span
        aria-hidden
        className="h-px min-w-2 flex-1 bg-muted-foreground/25"
      />
      {action && <span className="flex shrink-0 items-center">{action}</span>}
    </div>
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

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-xs text-muted-foreground">{children}</p>
  );
}
