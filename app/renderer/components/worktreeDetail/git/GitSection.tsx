import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { RelativeDate } from "@/components/ui/relative-date";
import { SectionHeading } from "@/components/ui/section-heading";
import { useWorktreeStashes } from "@/hooks/worktrees/useGitHistory";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import { canSyncFromPrimary } from "@/lib/syncState";
import { cn } from "@/lib/utils";
import { getBrowseLeafSegment } from "@shared/projectPaths";
import type { Worktree } from "@shared/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { OperationBanner } from "./OperationBanner";

// How many changed files the Changes row names before it just counts.
const NAMED_FILES = 3;

// The worktree page's way into the Git page, where git is done: a row
// per tab of it (Changes, Stashes, History), each saying what is there
// and opening it, and in the heading the moves worth a click from here,
// pushing and syncing from the primary branch. A merge or rebase
// stopped on conflicts shows above, since nothing else moves until it
// is settled.
export function GitSection({ worktree }: { worktree: Worktree }) {
  const nav = useWorktreeNav();
  const { projectId, id: worktreeId } = worktree;
  const { data: files = [] } = useWorktreeChanges(projectId, worktreeId);
  const { data: stashes = [] } = useWorktreeStashes(worktree);
  const last = worktree.recentCommits[0];
  const named = files.slice(0, NAMED_FILES);
  const unnamed = worktree.changedCount - named.length;
  const newestStash = stashes[0];

  return (
    <section className="space-y-2">
      {/* Held at the heading's height: the pills overhang it, so the
          rows don't shift when one appears. */}
      <div className="flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1">
        <SectionHeading>Git</SectionHeading>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <WorktreeSyncPill worktree={worktree} />
          {canSyncFromPrimary(worktree) && (
            <WorktreePrimarySyncPill worktree={worktree} />
          )}
          <button
            type="button"
            onClick={() => nav.toDiff(projectId, worktreeId)}
            className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open
            <ChevronRight aria-hidden className="size-3.5 opacity-60" />
          </button>
        </div>
      </div>
      <OperationBanner worktree={worktree} />
      <div className="flex flex-col">
        <EntryRow
          label="Changes"
          onOpen={() => nav.toDiff(projectId, worktreeId)}
        >
          {worktree.changedCount > 0 ? (
            <>
              {pluralize(worktree.changedCount, "file")} changed
              {named.length > 0 && (
                <Detail>
                  {named.map((f) => getBrowseLeafSegment(f.path)).join(", ")}
                  {unnamed > 0 && ` and ${unnamed} more`}
                </Detail>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">
              No uncommitted changes
            </span>
          )}
        </EntryRow>
        {newestStash && (
          <EntryRow
            label="Stashes"
            onOpen={() => nav.toStash(projectId, worktreeId, newestStash.hash)}
          >
            {pluralize(stashes.length, "stash", "stashes")}
            <Detail>
              {newestStash.named ? newestStash.message : "Stashed changes"}
              {", "}
              <RelativeDate date={newestStash.date} />
            </Detail>
          </EntryRow>
        )}
        <EntryRow
          label="History"
          onOpen={
            last
              ? () => nav.toCommit(projectId, worktreeId, last.hash)
              : undefined
          }
        >
          {last ? (
            <>
              {last.subject}
              <Detail>
                <RelativeDate date={last.date} />
              </Detail>
            </>
          ) : (
            <span className="text-muted-foreground">No commits yet</span>
          )}
        </EntryRow>
      </div>
    </section>
  );
}

// One way into the Git page: the tab's name, what it holds, and the
// chevron that says where the row leads. Without `onOpen` (no commits
// for History) it only says.
function EntryRow({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: (() => void) | undefined;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="w-16 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{children}</span>
      {onOpen && (
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/40"
        />
      )}
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

function Detail({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground">
      {" · "}
      {children}
    </span>
  );
}
