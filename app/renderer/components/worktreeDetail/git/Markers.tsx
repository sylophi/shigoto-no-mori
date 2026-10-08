import type { ReactNode } from "react";
import { Cloud, GitFork } from "lucide-react";
import { useWorktreeOperation } from "@/hooks/worktrees/useGitHistory";
import { pluralize } from "@/lib/pluralize";
import { canSyncFromPrimary } from "@/lib/syncState";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";
import { WorktreePrimarySyncPill } from "../WorktreePrimarySyncPill";
import { WorktreeSyncPill } from "../WorktreeSyncPill";
import { TimelineRow } from "./TimelineRow";

// A ref on the timeline, at the commit it points to: its name, what it
// says about the commits around it, and the one move that brings it in
// line.
function MarkerRow({
  icon,
  name,
  note,
  move,
  children,
}: {
  icon: ReactNode;
  name: ReactNode | null;
  note?: ReactNode;
  move?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <TimelineRow node={icon}>
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 py-1">
        {name !== null && (
          <span className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {name}
          </span>
        )}
        {note && (
          <span className="min-w-0 text-xs text-muted-foreground">{note}</span>
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
      move={<WorktreeSyncPill worktree={worktree} />}
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
  const behind = worktree.behindPrimary;
  // A stopped merge or rebase is the sync under way, or something else
  // to finish first: either way not a moment to point at the sync.
  const { data: operation } = useWorktreeOperation(worktree);
  const stopped =
    operation !== undefined &&
    (operation.operation !== null || operation.conflicted > 0);
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
          <WorktreePrimarySyncPill worktree={worktree} label="Sync" />
        ) : behind > 0 && worktree.changedCount > 0 && !stopped ? (
          <span className="text-xs text-muted-foreground">
            Commit or stash to sync
          </span>
        ) : undefined
      }
    >
      {children}
    </MarkerRow>
  );
}
