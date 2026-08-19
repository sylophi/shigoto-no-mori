import { Archive, ArchiveRestore, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { BranchLabel } from "@/components/ui/branch-label";
import { WorktreeKindIcon } from "@/components/WorktreeKindIcon";
import { useSetShelved } from "@/hooks/worktrees/useWorktreeMutations";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { ScriptActivityKind } from "@/store/scriptRuns";
import {
  isManagedWorktree,
  worktreeLastActivityAt,
  type PullRequest,
  type Worktree,
} from "@shared/schemas";
import { ActivityIcon } from "../ActivityIcon";
import { ProjectIcon } from "../ProjectIcon";
import { PullRequestPill } from "../PullRequestPill";
import { ChangedFilesPill, RemoteSyncPill } from "../StatusIndicator";
import { useWorktreeRowState } from "../useWorktreeRowState";

interface InboxRowProps {
  worktree: Worktree;
  projectName: string;
  pr: PullRequest | undefined;
}

// The inbox row answers a different question from the tree row. In the
// tree you already know the project and you're picking a branch out of
// a short list, so one line of chrome is enough. Here every row comes
// from somewhere else and you're triaging: which repo, which branch,
// what state it's in, and when it last moved. That's three lines, and
// it's why this isn't WorktreeRow with a prop. The behaviour the two do
// share lives in useWorktreeRowState.
//
//   [icon] project                                  14m ago
//   feat/the-branch                            ±3  ↑2  #142
//   [kind] dirname
export function InboxRow({ worktree, projectName, pr }: InboxRowProps) {
  const { isSelected, open, activity, isDeleting, title } =
    useWorktreeRowState(worktree);

  return (
    // A div, not a button: the shelve control is a button of its own and
    // nesting one inside another is invalid. Enter/Space are wired by
    // hand to keep the row keyboard-operable.
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        // Only when the row itself has focus. The shelve button inside it
        // is keyboard-reachable, and swallowing its Enter would navigate
        // instead of shelving.
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
      title={title}
      className={cn(
        "group/inbox-row flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none",
        "hover:bg-accent/60 focus-visible:bg-accent/60",
        isSelected && "bg-accent text-accent-foreground",
        isDeleting && "opacity-50",
        worktree.shelved && !isSelected && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <ProjectIcon
          projectId={worktree.projectId}
          className="size-3"
          fallback={Folder}
        />
        <span className="min-w-0 truncate font-medium">{projectName}</span>
        <TrailingSlot
          worktree={worktree}
          activity={activity}
          isDeleting={isDeleting}
        />
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
          <BranchLabel branch={worktree.branch} detached={worktree.detached} />
        </span>
        <ChangedFilesPill worktree={worktree} />
        <RemoteSyncPill worktree={worktree} />
        <PullRequestPill pr={pr} showNumber />
      </div>

      {/* The worktree's own name gets a line to itself rather than
          sharing one with the project: they're both "where is this",
          and side by side the longer one just eats the other.
          The kind glyph leads it, since it describes this worktree and
          not the project above. Shelved is the one kind left out: it
          would restate the shelf header the row is already under, and
          primaries never reach the inbox at all. */}
      <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/70">
        {!worktree.shelved && (
          <WorktreeKindIcon worktree={worktree} showTooltip={false} />
        )}
        <span className="min-w-0 truncate">{worktree.name}</span>
      </span>
    </div>
  );
}

// Right end of the context line: normally "when did this last move",
// which is what the inbox sorts on. A running script or a delete in
// flight displaces it -- those are happening now, so they outrank a
// timestamp. Hovering swaps in the shelve toggle, so the list can be
// triaged without opening every row.
function TrailingSlot({
  worktree,
  activity,
  isDeleting,
}: {
  worktree: Worktree;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
}) {
  const setShelved = useSetShelved();
  const activityAt = worktreeLastActivityAt(worktree);
  const canShelve = isManagedWorktree(worktree) && !isDeleting;

  // Both children share one grid cell, so the timestamp can fade out and
  // the button fade in without either moving: the cell is as wide as the
  // wider of the two, always. Cross-fading rather than swapping `hidden`
  // also keeps the button in the tab order -- a display:none control
  // would make shelving mouse-only.
  return (
    <span className="ml-auto grid shrink-0 grid-cols-1 items-center justify-items-end">
      <span
        className={cn(
          "col-start-1 row-start-1 flex items-center",
          canShelve &&
            "transition-opacity group-focus-within/inbox-row:opacity-0 group-hover/inbox-row:opacity-0",
        )}
      >
        {isDeleting ? (
          <ActivityIcon kind="teardown" />
        ) : activity ? (
          <ActivityIcon kind={activity} />
        ) : (
          <span className="tabular">
            {activityAt > 0 ? formatRelativeTime(activityAt) : "no activity"}
          </span>
        )}
      </span>
      {canShelve && (
        <button
          type="button"
          // Only the row navigates on click. This must not do both.
          onClick={(event) => {
            event.stopPropagation();
            setShelved.mutate({
              projectId: worktree.projectId,
              worktreeId: worktree.id,
              shelved: !worktree.shelved,
            });
          }}
          disabled={setShelved.isPending}
          aria-label={
            worktree.shelved ? "Unshelve worktree" : "Shelve worktree"
          }
          title={worktree.shelved ? "Unshelve" : "Shelve"}
          className="col-start-1 row-start-1 rounded-sm p-0.5 opacity-0 transition-opacity group-focus-within/inbox-row:opacity-100 group-hover/inbox-row:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          {worktree.shelved ? (
            <ArchiveRestore aria-hidden className="size-3" />
          ) : (
            <Archive aria-hidden className="size-3" />
          )}
        </button>
      )}
    </span>
  );
}
