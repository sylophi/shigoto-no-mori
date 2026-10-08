import { useState, type ReactNode } from "react";
import { EllipsisVertical, Layers, Search } from "lucide-react";
import { useDebouncedValue } from "@/hooks/ui/useDebouncedValue";
import {
  useBranchCommits,
  useBranchHistory,
} from "@/hooks/git/useBranchCommits";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { commitRewriteAt, NO_REWRITE } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { hasRemoteMarker } from "@/lib/syncState";
import {
  deriveRemoteSyncState,
  type BranchHistory,
  type CommitSummary,
  type Worktree,
} from "@shared/schemas";
import { CommitNode } from "./CommitNode";
import { BaseMarker, RemoteMarker } from "./Markers";
import {
  Rail,
  TimelineRow,
  TimelineSelection,
  useRowSelection,
} from "./TimelineRow";
import { useCommitActions, type CommitActions } from "./useCommitActions";

// How many of the branch's own commits show before the rest fold into
// a "more" row. A branch rarely runs past it.
const SHOWN_COMMITS = 10;

type Row = { key: string; row: ReactNode };

// The Git page's History tab: the branch's own commits, newest first,
// with where the remote stands among them (the commits above it are the
// ones it doesn't have yet, and the push sits on it) and where the
// branch left the primary branch (with the sync), led by a row for
// everything the branch changes. The history before the branch folds
// behind its marker, and the search reaches all of it.
export function GitTimeline({
  worktree,
  selected,
}: {
  worktree: Worktree;
  // `branch` or `commit:<hash>`: what the page shows.
  selected: string | null;
}) {
  const { projectId, id: worktreeId } = worktree;
  const head = worktree.recentCommits[0]?.hash;
  const { data: history } = useBranchHistory(projectId, worktreeId, head);
  const actions = useCommitActions(worktree);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 250);

  return (
    <TimelineSelection value={selected}>
      <section className="space-y-1">
        <div
          data-slot="search-row"
          className="-mx-3 flex items-center gap-1.5 border-b border-border px-3.5 py-1.5"
        >
          <Search
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/60"
          />
          <input
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
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        {query ? (
          <SearchResults worktree={worktree} query={query} actions={actions} />
        ) : (
          <Timeline worktree={worktree} history={history} actions={actions} />
        )}
        {actions.dialog}
      </section>
    </TimelineSelection>
  );
}

function Timeline({
  worktree,
  history,
  actions,
}: {
  worktree: Worktree;
  history: BranchHistory | undefined;
  actions: CommitActions;
}) {
  const [expanded, setExpanded] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);

  const own = history?.commits ?? [];
  const base = history?.base ?? null;
  // Where the remote's marker goes among the commits: under the ones it
  // doesn't have yet, or under all of them when the branch was never
  // published.
  const remoteAt = hasRemoteMarker(worktree)
    ? deriveRemoteSyncState(worktree).kind === "publish"
      ? own.length
      : Math.min(worktree.ahead, own.length)
    : null;
  // A long branch folds its older commits, but never above the remote.
  const shown =
    base === null || expanded || own.length <= SHOWN_COMMITS + 2
      ? Math.min(own.length, base === null ? SHOWN_COMMITS : own.length)
      : Math.max(SHOWN_COMMITS, remoteAt ?? 0);
  const folded = base === null ? 0 : own.length - shown;
  // Past the branch: from where it left the primary branch, or without
  // one, past the newest commits shown.
  const earlierFrom = base ? base.hash : own[shown]?.hash;

  const rows: Row[] = [];
  const remoteRow: Row | null =
    remoteAt === null || history === undefined
      ? null
      : {
          key: "remote",
          row: <RemoteMarker worktree={worktree} upstream={history.upstream} />,
        };
  own.slice(0, shown).forEach((commit, index) => {
    if (index === remoteAt && remoteRow) rows.push(remoteRow);
    rows.push({
      key: commit.hash,
      row: (
        <CommitNode
          worktree={worktree}
          commit={commit}
          rewrite={commitRewriteAt(worktree, own, index)}
          actions={actions}
          local={index < worktree.unpushedCount}
        />
      ),
    });
  });
  if (remoteAt !== null && remoteAt >= shown && remoteRow) {
    rows.push(remoteRow);
  }
  if (folded > 0) {
    rows.push({
      key: "folded",
      row: (
        <TimelineRow
          node={
            <EllipsisVertical
              aria-hidden
              className="size-3.5 text-muted-foreground"
            />
          }
        >
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            {pluralize(folded, "more commit")}
          </button>
        </TimelineRow>
      ),
    });
  }
  const pastLinks = (
    <div className="flex flex-wrap items-center gap-x-3 pb-1 text-xs">
      {earlierFrom && (
        <button
          type="button"
          aria-expanded={earlierOpen}
          onClick={() => setEarlierOpen((open) => !open)}
          className="py-1 text-muted-foreground hover:text-foreground"
        >
          {earlierOpen ? "Hide earlier history" : "Earlier history"}
        </button>
      )}
    </div>
  );
  if (base) {
    rows.push({
      key: "base",
      row: (
        <BaseMarker worktree={worktree} base={base.ref}>
          {pastLinks}
        </BaseMarker>
      ),
    });
  }

  return (
    <div>
      {base && own.length > 0 && (
        <BranchChangesRow worktree={worktree} base={base.ref} />
      )}
      <Rail rows={rows} />
      {history === undefined && (
        <div className="py-1.5 pl-5 text-sm text-muted-foreground">
          Reading the history…
        </div>
      )}
      {history && !base && earlierFrom && !earlierOpen && (
        <div className="pl-5">{pastLinks}</div>
      )}
      {earlierOpen && earlierFrom && (
        <EarlierHistory
          worktree={worktree}
          from={earlierFrom}
          actions={actions}
        />
      )}
    </div>
  );
}

// The History tab's first row: everything the branch changes since it
// left the primary branch, picked like a commit.
function BranchChangesRow({
  worktree,
  base,
}: {
  worktree: Worktree;
  base: string;
}) {
  const nav = useWorktreeNav();
  const selected = useRowSelection("branch");
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={() => nav.toBranchDiff(worktree.projectId, worktree.id, true)}
      className={cn(
        "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">All branch changes</span>
        <span className="block truncate text-xs text-muted-foreground">
          Since {base}
        </span>
      </span>
    </button>
  );
}

// The history before what the timeline shows, faded: the primary
// branch's, which nothing here rewrites.
function EarlierHistory({
  worktree,
  from,
  actions,
}: {
  worktree: Worktree;
  from: string;
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
  const commits = data ? data.pages.flat() : [];
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
  if (!isLoading && commits.length === 0) {
    return (
      <div className="py-1.5 text-sm text-muted-foreground">
        No commit messages match.
      </div>
    );
  }
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

// Commits off the branch's own line (a search's, the history before
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
    <div>
      <Rail
        rows={commits.map((commit) => ({
          key: commit.hash,
          row: (
            <CommitNode
              worktree={worktree}
              commit={commit}
              rewrite={NO_REWRITE}
              actions={actions}
              local={false}
              faded={faded}
            />
          ),
        }))}
      />
      {more && (
        <button
          type="button"
          disabled={more.pending}
          onClick={more.load}
          className="py-1.5 pl-5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {more.pending ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
