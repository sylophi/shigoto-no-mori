import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DiffStats } from "@shigomori/ui/primitives/diff-stats.tsx";
import { RelativeDate } from "@shigomori/ui/primitives/relative-date.tsx";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { getBrowseLeafSegment } from "@shigomori/contracts/projectPaths";
import type {
  CommitSummary,
  ChangedFile,
  StashEntry,
  Worktree,
} from "@shigomori/contracts/schemas";

// How many changed files the Changes row names before it just counts.
const NAMED_FILES = 3;

// The worktree page's way into the Git page, where git is done: a row
// per tab of it (Changes, Stashes, History), each saying what is there
// and opening it, and in the heading the moves worth a click from here,
// pushing and syncing from the primary branch. A merge or rebase
// stopped on conflicts shows above, since nothing else moves until it
// is settled. Everything here reads, and opens the Git page to act
// (GitSection reads it all).
export function GitSectionView({
  worktree,
  files,
  stashes,
  commits,
  branch,
  syncPills,
  operationBanner,
  nav,
}: {
  worktree: Worktree;
  // The uncommitted changes, the stashes, newest first, and the
  // newest commits.
  files: readonly ChangedFile[];
  stashes: readonly StashEntry[];
  commits: readonly CommitSummary[];
  // How the branch stands against the primary branch: its own commits
  // and whether there are more than were read.
  branch?: { base: string; own: number; more: boolean };
  // The heading's moves (WorktreeSyncPill, WorktreePrimarySyncPill),
  // and a merge or rebase stopped on conflicts (OperationBanner).
  syncPills: ReactNode;
  operationBanner: ReactNode;
  nav: {
    toDiff: () => void;
    toStash: (hash: string) => void;
    toCommit: (hash: string) => void;
    toBranchDiff: () => void;
  };
}) {
  const named = files.slice(0, NAMED_FILES);
  const unnamed = worktree.changedCount - named.length;
  const newestStash = stashes[0];
  const sum = (side: "additions" | "deletions") =>
    files.reduce((n, file) => n + (file.counts?.[side] ?? 0), 0);

  return (
    <section className="space-y-2">
      {/* Held at the heading's height: the pills overhang it, so the
          rows don't shift when one appears. */}
      <div className="flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1">
        <SectionHeading>Git</SectionHeading>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {syncPills}
        </div>
      </div>
      {operationBanner}
      <div className="flex flex-col">
        <EntryRow
          label="Changes"
          onOpen={nav.toDiff}
          trailing={
            files.length > 0 && (
              <DiffStats
                additions={sum("additions")}
                deletions={sum("deletions")}
              />
            )
          }
        >
          {worktree.changedCount > 0 ? (
            <>
              {pluralize(worktree.changedCount, "file")} changed
              {named.length > 0 && (
                <Aside>
                  {named.map((f) => getBrowseLeafSegment(f.path)).join(", ")}
                  {unnamed > 0 && ` and ${unnamed} more`}
                </Aside>
              )}
            </>
          ) : (
            <Muted>No uncommitted changes</Muted>
          )}
        </EntryRow>
        {newestStash && (
          <EntryRow
            label="Stashes"
            onOpen={() => nav.toStash(newestStash.hash)}
            trailing={
              <Muted>
                <RelativeDate date={newestStash.date} />
              </Muted>
            }
          >
            {pluralize(stashes.length, "stash", "stashes")}
            <Aside>
              {newestStash.named
                ? newestStash.message
                : `On top of ${newestStash.message}`}
            </Aside>
          </EntryRow>
        )}
        {commits.length === 0 ? (
          <EntryRow label="History" onOpen={undefined}>
            <Muted>No commits yet</Muted>
          </EntryRow>
        ) : (
          commits.map((commit, index) => (
            <CommitRow
              key={commit.hash}
              label={index === 0 ? "History" : ""}
              commit={commit}
              local={index < worktree.unpushedCount}
              onOpen={() => nav.toCommit(commit.hash)}
            />
          ))
        )}
        {branch && (
          <BranchLine
            behind={worktree.behindPrimary}
            {...branch}
            onOpen={nav.toBranchDiff}
          />
        )}
      </div>
    </section>
  );
}

// One way into the Git page: the tab's name (on its first row), what
// it holds, a trailing figure, and the chevron that says where the row
// leads. Without `onOpen` it only says.
function EntryRow({
  label,
  onOpen,
  trailing,
  children,
}: {
  label: string;
  onOpen: (() => void) | undefined;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="w-16 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{children}</span>
      {trailing && (
        <span className="flex shrink-0 items-center gap-3 text-xs">
          {trailing}
        </span>
      )}
      <ChevronRight
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground/40",
          !onOpen && "invisible",
        )}
      />
    </>
  );
  const shape =
    "-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-1.5 text-left";
  if (!onOpen) return <div className={shape}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        shape,
        "transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {body}
    </button>
  );
}

// A commit under History: whether a remote has it yet, its subject,
// and in fixed columns its hash, age and size, so they line up.
function CommitRow({
  label,
  commit,
  local,
  onOpen,
}: {
  label: string;
  commit: CommitSummary;
  local: boolean;
  onOpen: () => void;
}) {
  return (
    <EntryRow
      label={label}
      onOpen={onOpen}
      trailing={
        <span className="grid grid-cols-[4.5rem_4.5rem_4.5rem] items-center text-muted-foreground phone:grid-cols-[4.5rem_4.5rem]">
          <span className="font-mono phone:hidden">{commit.hash}</span>
          <span className="truncate">
            <RelativeDate date={commit.date} />
          </span>
          <span className="flex justify-end">
            {(commit.additions > 0 || commit.deletions > 0) && (
              <DiffStats
                additions={commit.additions}
                deletions={commit.deletions}
              />
            )}
          </span>
        </span>
      }
    >
      <span className="mr-2 inline-flex align-middle">
        <CommitDot local={local} />
      </span>
      {commit.subject}
    </EntryRow>
  );
}

// Under the newest commits: how the branch stands against the primary
// branch ("5 commits ahead of origin/main, 4 behind"), and the way to
// everything it changes at once.
function BranchLine({
  behind,
  base,
  own,
  more,
  onOpen,
}: {
  behind: number;
  base: string;
  own: number;
  // More commits than the history read returned.
  more: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pl-[4.75rem] text-xs text-muted-foreground">
      <span>
        {more ? `${own}+ commits` : pluralize(own, "commit")} ahead of {base}
        {behind > 0 && `, ${behind} behind`}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="ml-auto inline-flex items-center gap-0.5 hover:text-foreground"
      >
        All branch changes
        <ChevronRight aria-hidden className="size-3.5 opacity-60" />
      </button>
    </div>
  );
}

// A commit's mark: the accent while it exists only here, muted once a
// remote has it.
function CommitDot({ local }: { local: boolean }) {
  return (
    <span
      className={cn(
        "size-2.5 rounded-full",
        local ? "bg-emerald-500" : "bg-muted-foreground/45",
      )}
    />
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

// What follows a row's figure, set apart by space and tone rather than
// a separator.
function Aside({ children }: { children: ReactNode }) {
  return <span className="ml-2 text-muted-foreground">{children}</span>;
}
