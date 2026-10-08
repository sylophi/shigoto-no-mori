import type { ReactNode } from "react";
import { Cloud, GitFork } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useWorktreeOperation } from "@/hooks/worktrees/useGitHistory";
import { pluralize } from "@/lib/pluralize";
import { canSyncFromPrimary } from "@/lib/syncState";
import { cn } from "@/lib/utils";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { TimelineRow, useTimelineView } from "./TimelineRow";

// A ref on the timeline, at the commit it points to: its name, what it
// says about the commits around it, and the one move that brings it in
// line. In the Git page's narrow History tab it keeps to one line: the
// name and the move, the note in the name's tooltip.
function MarkerRow({
  icon,
  name,
  note,
  move,
  children,
}: {
  icon: ReactNode;
  name: ReactNode | null;
  note?: string;
  move?: ReactNode;
  children?: ReactNode;
}) {
  const { onGitPage } = useTimelineView();
  const chip = name !== null && (
    <span className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {name}
    </span>
  );
  return (
    <TimelineRow node={icon}>
      <div
        className={cn(
          "flex min-h-8 items-center gap-x-2 py-1",
          !onGitPage && "flex-wrap gap-y-1",
        )}
      >
        {onGitPage ? (
          chip ? (
            // The note isn't on screen here, so the name's tooltip says
            // it. Without one, the tooltip only finishes a name cut off.
            <SimpleTooltip
              tip={note ? `${name} · ${note}` : name}
              whenTruncated={!note}
            >
              {chip}
            </SimpleTooltip>
          ) : (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {note}
            </span>
          )
        ) : (
          <>
            {chip}
            {note && (
              <span className="min-w-0 text-xs text-muted-foreground">
                {note}
              </span>
            )}
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center">{move}</span>
      </div>
      {children}
    </TimelineRow>
  );
}

// Where the upstream stands. The commits above it are the ones it
// doesn't have yet, so the push (or pull, or publish) sits right here.
export function RemoteMarker({
  worktree,
  upstream,
}: {
  worktree: Worktree;
  upstream: string | null;
}) {
  const { onGitPage } = useTimelineView();
  // The pill says the counts. The note only what no pill does.
  const state = deriveRemoteSyncState(worktree);
  const note =
    state.kind === "synced"
      ? "Up to date"
      : state.kind === "publish"
        ? "Not on the remote yet"
        : state.kind === "diverged"
          ? "The histories have split"
          : undefined;
  return (
    <MarkerRow
      icon={<Cloud aria-hidden className="size-3.5 text-muted-foreground" />}
      name={upstream}
      note={note}
      move={<WorktreeSyncPill worktree={worktree} compact={onGitPage} />}
    />
  );
}

// Where the branch left the primary branch, and how far that has moved
// on since. Under it, the ways past the branch's own commits.
export function BaseMarker({
  worktree,
  base,
  children,
}: {
  worktree: Worktree;
  base: string;
  children?: ReactNode;
}) {
  const { onGitPage } = useTimelineView();
  const behind = worktree.behindPrimary;
  // A stopped merge or rebase is the sync under way, or something else
  // to finish first: either way not a moment to point at the sync.
  const { data: operation } = useWorktreeOperation(worktree);
  const stopped =
    operation !== undefined &&
    (operation.operation !== null || operation.conflicted > 0);
  const waiting = behind > 0 && worktree.changedCount > 0 && !stopped;
  return (
    <MarkerRow
      icon={<GitFork aria-hidden className="size-3.5 text-muted-foreground" />}
      name={base}
      note={
        behind > 0
          ? `This branch began here · ${pluralize(behind, "new commit")} since`
          : "This branch began here"
      }
      move={
        canSyncFromPrimary(worktree) ? (
          <WorktreePrimarySyncPill
            worktree={worktree}
            label={onGitPage ? `Sync ${behind}` : "Sync"}
          />
        ) : waiting ? (
          onGitPage ? (
            <SimpleTooltip tip="Commit or stash to sync">
              <span className="text-xs text-muted-foreground">
                {behind} behind
              </span>
            </SimpleTooltip>
          ) : (
            <span className="text-xs text-muted-foreground">
              Commit or stash to sync
            </span>
          )
        ) : undefined
      }
    >
      {children}
    </MarkerRow>
  );
}
