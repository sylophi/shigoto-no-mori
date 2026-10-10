import { use, useState, type ReactNode } from "react";
import { Cloud, CloudOff, GitFork, Split } from "lucide-react";
import { useDebouncedValue } from "@/hooks/ui/useDebouncedValue";
import {
  useBranchCommits,
  useBranchHistory,
} from "@/hooks/git/useBranchCommits";
import { useCommitRewrites } from "@/hooks/worktrees/useCommitRewrites";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { NO_REWRITE, type CommitRewrite } from "@/lib/commitRewrite";
import { pluralize } from "@shigomori/ui/lib/pluralize.ts";
import {
  deriveRemoteSyncState,
  type BranchHistory,
  type CommitSummary,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { CommitRow } from "./CommitRow";
import { HistorySelection } from "./CommitRowView";
import {
  BranchChangesRowView,
  EarlierToggleView,
  HistoryListView,
  NoteView,
  RefLineView,
  ShowMoreView,
  SplitHeaderView,
  UpToDateView,
} from "./HistoryListView";
import { useCommitActions, type CommitActions } from "./useCommitActions";

// The Git page's History tab (HistoryListView): a search field, the
// branch's whole diff, then its commits, newest first, with the refs
// that matter drawn as lines across the list where they point. The
// remote's copy of the branch sits under the commits it doesn't have
// yet, with the push, and the primary branch where the branch began,
// with the sync. Under that, folded, the history before the branch.
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
    <HistoryListView
      selected={selected}
      search={search}
      onSearchChange={setSearch}
      body={
        query ? (
          <SearchResults worktree={worktree} query={query} actions={actions} />
        ) : (
          <BranchCommits worktree={worktree} actions={actions} />
        )
      }
      dialog={actions.dialog}
    />
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
  const rewriteAt = useCommitRewrites(worktree, history?.commits ?? []);
  const [earlierOpen, setEarlierOpen] = useState(false);
  if (!history) {
    return <NoteView>Reading the history…</NoteView>;
  }
  const own = history.commits;
  const base = history.base;
  const unpushed = new Set(history.unpushed);

  // Past what the history read holds: past a branch longer than the
  // read, from its oldest commit shown, else from where the branch left
  // the primary branch. Without one (the primary checkout), only when
  // there is more than the read held.
  const earlierFrom = history.more ? own.at(-1)?.hash : base?.hash;
  const split = history.unpushed.length > 0 && history.incoming.length > 0;
  const props = { worktree, history, unpushed, rewriteAt, actions };

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
      {split ? <SplitRows {...props} /> : <LineRows {...props} />}
      {earlierFrom && (
        <>
          <EarlierToggleView
            open={earlierOpen}
            onToggle={() => setEarlierOpen((open) => !open)}
          />
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

type RowsProps = {
  worktree: Worktree;
  history: BranchHistory;
  unpushed: ReadonlySet<string>;
  rewriteAt: (index: number) => CommitRewrite;
  actions: CommitActions;
};

// The remote's name where the upstream is a branch of the local
// branch's own name (the usual case), as GitHub Desktop's "Push origin"
// says it. The full name otherwise.
function remoteName(worktree: Worktree, upstream: string | null): string {
  if (upstream?.endsWith(`/${worktree.branch}`)) {
    return upstream.slice(0, -worktree.branch.length - 1);
  }
  return upstream ?? "remote";
}

// One straight line of history: the branch's commits with the remote's
// line under the ones it lacks (the publish line over all of them for a
// branch on no remote yet) and the primary branch's where the branch
// began. Where the commits the remote lacks aren't the newest run (a
// merge brought older ones in), the remote's line sits on top and those
// rows carry a mark of their own.
function LineRows({
  worktree,
  history,
  unpushed,
  rewriteAt,
  actions,
}: RowsProps) {
  const own = history.commits;
  const state = deriveRemoteSyncState(worktree);
  const pill = <WorktreeSyncPill worktree={worktree} compact />;
  const lacked = own.filter((c) => unpushed.has(c.hash)).length;
  const run = own.slice(0, lacked).every((c) => unpushed.has(c.hash));
  const upstream = history.upstream ?? "The remote";
  let remote: { at: number; line: ReactNode } | null = null;
  if (state.kind === "publish") {
    if (state.canPublish) {
      remote = {
        at: 0,
        line: (
          <RefLineView
            key="remote"
            icon={<CloudOff aria-hidden className="size-3.5" />}
            name="Local only"
            tip="On no remote yet: Publish puts it there"
            action={pill}
          />
        ),
      };
    }
  } else if (state.kind !== "detached") {
    remote = {
      at: run ? lacked : 0,
      line: (
        <RefLineView
          key="remote"
          icon={<Cloud aria-hidden className="size-3.5" />}
          name={remoteName(worktree, history.upstream)}
          mono
          tip={
            run
              ? `${upstream} has everything from here down`
              : `${upstream} lacks the commits marked as not pushed`
          }
          action={state.kind === "synced" ? <UpToDateView /> : pill}
        />
      ),
    };
  }
  const rows: ReactNode[] = [];
  own.forEach((commit, index) => {
    if (remote?.at === index) rows.push(remote.line);
    rows.push(
      <CommitRow
        key={commit.hash}
        worktree={worktree}
        commit={commit}
        rewrite={rewriteAt(index)}
        actions={actions}
        unpushed={!run && unpushed.has(commit.hash)}
      />,
    );
  });
  if (remote && remote.at >= own.length) rows.push(remote.line);
  if (history.base) {
    rows.push(
      <BaseLine key="base" worktree={worktree} base={history.base.ref} />,
    );
  }
  return rows;
}

// The branch and its remote copy each hold commits the other lacks, so
// no one line of history holds both. A "split" line leads, with the two
// sides to pick between (this branch's own commits, or the remote's,
// read only) and the move that brings them together. Under the side
// shown, a line marks where the two last agreed, and everything under it
// is on both. Where they last agreed further back than where the branch
// began (it was rebased after it was pushed), that line sits under the
// primary branch's.
function SplitRows({
  worktree,
  history,
  unpushed,
  rewriteAt,
  actions,
}: RowsProps) {
  const own = history.commits;
  const name = remoteName(worktree, history.upstream);
  const upstream = history.upstream ?? name;
  // Opened on one of the remote's commits, the remote's side shows.
  const selected = use(HistorySelection);
  const [side, setSide] = useState<"here" | "remote">(() =>
    history.incoming.some((c) => selected === `commit:${c.hash}`)
      ? "remote"
      : "here",
  );
  const mine = own.filter((c) => unpushed.has(c.hash));
  const theirs = history.incoming;
  const sharedAt = own.findIndex((c) => !unpushed.has(c.hash));
  const forkAtBase =
    history.base !== null && history.upstreamFork === history.base.hash;
  const sharedLine = (back: boolean) => (
    <RefLineView
      key="shared"
      icon={<Cloud aria-hidden className="size-3.5" />}
      name={back ? "Shared further back" : "Shared from here"}
      tip={
        back
          ? `${upstream} split off before ${history.base?.ref ?? "these commits"}`
          : `This branch and ${upstream} both have everything from here down`
      }
    />
  );

  const rows: ReactNode[] = [
    <SplitHeaderView
      key="split"
      refLine={
        <RefLineView
          icon={<Split aria-hidden className="size-3.5" />}
          name={`Split from ${name}`}
          tip={`This branch and ${upstream} each have commits the other lacks`}
        />
      }
      side={side}
      onSide={setSide}
      hereCount={mine.length}
      remoteLabel={`${name} ${theirs.length}${history.incomingMore ? "+" : ""}`}
      pill={<WorktreeSyncPill worktree={worktree} compact />}
    />,
  ];
  if (side === "here") {
    own.forEach((commit, index) => {
      if (!unpushed.has(commit.hash)) return;
      rows.push(
        <CommitRow
          key={commit.hash}
          worktree={worktree}
          commit={commit}
          rewrite={rewriteAt(index)}
          actions={actions}
        />,
      );
    });
  } else {
    for (const commit of theirs) {
      rows.push(
        <CommitRow
          key={commit.hash}
          worktree={worktree}
          commit={commit}
          rewrite={NO_REWRITE}
          actions={actions}
          menu={false}
        />,
      );
    }
  }
  if (sharedAt >= 0) {
    rows.push(sharedLine(false));
    own.slice(sharedAt).forEach((commit, i) => {
      if (unpushed.has(commit.hash)) return;
      rows.push(
        <CommitRow
          key={commit.hash}
          worktree={worktree}
          commit={commit}
          rewrite={rewriteAt(sharedAt + i)}
          actions={actions}
        />,
      );
    });
  }
  if (history.base) {
    rows.push(
      <BaseLine key="base" worktree={worktree} base={history.base.ref} />,
    );
  }
  if (sharedAt < 0) rows.push(sharedLine(!forkAtBase));
  return rows;
}

// Where the branch left the primary branch, under the branch's own
// commits, carrying the sync once the primary branch has moved on (held
// while there are uncommitted changes, and saying why).
function BaseLine({ worktree, base }: { worktree: Worktree; base: string }) {
  const behind = worktree.behindPrimary;
  return (
    <RefLineView
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

function BranchChangesRow({
  worktree,
  ...props
}: {
  worktree: Worktree;
  base: string;
  own: number;
  more: boolean;
}) {
  const nav = useWorktreeNav();
  return (
    <BranchChangesRowView
      {...props}
      onOpen={() => nav.toBranchDiff(worktree.projectId, worktree.id, true)}
    />
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
      { query },
    );
  const commits = data ? data.pages.flat() : [];
  if (isLoading) return <NoteView>Searching…</NoteView>;
  if (commits.length === 0)
    return <NoteView>No commit messages match.</NoteView>;
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
      {more && <ShowMoreView pending={more.pending} onLoad={more.load} />}
    </>
  );
}
