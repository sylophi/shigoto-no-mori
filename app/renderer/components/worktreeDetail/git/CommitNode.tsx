import {
  Combine,
  Copy,
  Ellipsis,
  FolderGit2,
  GitBranchPlus,
  PencilLine,
  RotateCcw,
  TextCursorInput,
  Undo2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DiffStats } from "@/components/ui/diff-stats";
import { RelativeDate } from "@/components/ui/relative-date";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CommitRewrite } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import type { CommitSummary, Worktree } from "@shared/schemas";
import {
  CommitDot,
  TimelineRow,
  useRowSelection,
  useTimelineView,
} from "./TimelineRow";
import type { CommitActions } from "./useCommitActions";

// One commit on the Git timeline: its subject, where it can be read in
// full (the row opens its page), and its moves, behind a "⋯" that shows
// on hover or a right click.
export function CommitNode({
  worktree,
  commit,
  rewrite,
  actions,
  local,
  faded = false,
}: {
  worktree: Worktree;
  commit: CommitSummary;
  // What the timeline allows for this row (lib/commitRewrite). The
  // timeline knows the neighbours, the row doesn't.
  rewrite: CommitRewrite;
  // The timeline's one set of moves (useCommitActions), shared across
  // rows rather than subscribed to by each.
  actions: CommitActions;
  // On no remote yet.
  local: boolean;
  faded?: boolean;
}) {
  const nav = useWorktreeNav();
  const { onGitPage } = useTimelineView();
  const selected = useRowSelection(`commit:${commit.hash}`);
  const items = (
    <CommitMenuItems
      worktree={worktree}
      commit={commit}
      rewrite={rewrite}
      actions={actions}
    />
  );
  return (
    <TimelineRow node={<CommitDot local={local} />} faded={faded}>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className={cn(
                "group/commit -mx-1.5 flex items-start gap-1 rounded-md transition-colors",
                selected
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50 has-data-popup-open:bg-accent/50",
              )}
            />
          }
        >
          {/* One line where the timeline is wide (the worktree page),
              the subject over its hash, time and counts where it is a
              column (the Git page's sidebar). */}
          <button
            type="button"
            aria-current={selected || undefined}
            onClick={() =>
              nav.toCommit(
                worktree.projectId,
                worktree.id,
                commit.hash,
                onGitPage,
              )
            }
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring @md/timeline:flex-row @md/timeline:items-center @md/timeline:gap-3"
          >
            <span
              className={cn(
                "w-full truncate text-sm @md/timeline:w-auto @md/timeline:min-w-0 @md/timeline:flex-1",
                faded && "text-muted-foreground",
              )}
            >
              {commit.subject}
            </span>
            {/* Fixed columns when wide, so the hashes, the times and the
                counts line up down the timeline whatever each row holds. */}
            <span className="flex w-full items-center gap-2 text-xs text-muted-foreground @md/timeline:grid @md/timeline:w-auto @md/timeline:shrink-0 @md/timeline:grid-cols-[4.5rem_4rem_4.5rem] @md/timeline:gap-0">
              <span className="font-mono">{commit.hash}</span>
              <span className="truncate">
                <RelativeDate date={commit.date} />
              </span>
              <span className="ml-auto flex justify-end">
                {(commit.additions > 0 || commit.deletions > 0) && (
                  <DiffStats
                    additions={commit.additions}
                    deletions={commit.deletions}
                  />
                )}
              </span>
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${commit.hash}`}
              data-icon-button
              className="mt-1 mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/commit:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-popup-open:opacity-100 @md/timeline:mt-1 phone:opacity-100"
            >
              <Ellipsis aria-hidden className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={4}
              className="min-w-52"
            >
              {items}
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52">{items}</ContextMenuContent>
      </ContextMenu>
    </TimelineRow>
  );
}

// A commit's moves, for its "⋯" and its right click alike. The ones that
// rewrite it only while no remote has it (lib/commitRewrite).
export function CommitMenuItems({
  worktree,
  commit,
  rewrite,
  actions,
}: {
  worktree: Worktree;
  commit: CommitSummary;
  rewrite: CommitRewrite;
  actions: CommitActions;
}) {
  const nav = useWorktreeNav();
  const { canAmend, undo, reword, squash } = rewrite;
  const busy = actions.pending;
  return (
    <>
      {canAmend && (
        <DropdownMenuItem
          onClick={() =>
            nav.toDiff(worktree.projectId, worktree.id, { amend: true })
          }
        >
          <PencilLine />
          Amend…
        </DropdownMenuItem>
      )}
      {reword && !canAmend && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => actions.reword(commit, reword.head)}
        >
          <TextCursorInput />
          Reword…
        </DropdownMenuItem>
      )}
      {squash && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => actions.squash(commit, squash.head)}
        >
          <Combine />
          Squash into the commit below
        </DropdownMenuItem>
      )}
      {undo && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => actions.undoTo(undo.target, undo.count, undo.head)}
        >
          <Undo2 />
          {canAmend
            ? "Undo this commit"
            : `Undo the ${pluralize(undo.count, "commit")} above`}
          <span className="text-muted-foreground">(keeps changes)</span>
        </DropdownMenuItem>
      )}
      {(canAmend || reword || squash || undo) && <DropdownMenuSeparator />}
      <DropdownMenuItem disabled={busy} onClick={() => actions.revert(commit)}>
        <RotateCcw />
        Revert
      </DropdownMenuItem>
      {actions.pickTargets.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={busy}>
            <GitBranchPlus />
            Copy to another worktree
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {actions.pickTargets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                onClick={() => actions.cherryPickInto(target, commit)}
              >
                <span className="font-mono">{target.branch}</span>
                <span className="text-muted-foreground">{target.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuItem
        disabled={busy}
        onClick={() => actions.newWorktreeFrom(commit)}
      >
        <FolderGit2 />
        New worktree from here
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => void navigator.clipboard.writeText(commit.hash)}
      >
        <Copy />
        Copy hash
      </DropdownMenuItem>
    </>
  );
}
