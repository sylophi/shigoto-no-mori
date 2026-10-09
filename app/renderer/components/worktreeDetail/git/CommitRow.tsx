import { createContext, use } from "react";
import {
  CloudOff,
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
import type { CommitSummary, Worktree } from "@shigomori/contracts/schemas";
import type { CommitActions } from "./useCommitActions";

// The row the Git page shows, `branch` or `commit:<hash>`, marked in
// the History tab's list. A pick replaces the page's entry, so Back
// still leaves the page.
export const HistorySelection = createContext<string | null>(null);

export function useRowSelection(key: string): boolean {
  return use(HistorySelection) === key;
}

// One commit in the History tab's list, the same two lines as a stash:
// its subject, then its age and size. Picking it shows it beside the
// list. Its moves sit behind a "⋯" that floats over the first line's
// end on hover (so it takes no room from the counts) or a right click.
export function CommitRow({
  worktree,
  commit,
  rewrite,
  actions,
  faded = false,
  menu = true,
  unpushed = false,
}: {
  worktree: Worktree;
  commit: CommitSummary;
  // What the list allows for this row (lib/commitRewrite). The list
  // knows the neighbours, the row doesn't.
  rewrite: CommitRewrite;
  // The list's one set of moves (useCommitActions), shared across rows
  // rather than subscribed to by each.
  actions: CommitActions;
  // The history before the branch.
  faded?: boolean;
  // Off for a commit not on this branch (the remote's side of a split):
  // it can be read, and nothing here acts on it.
  menu?: boolean;
  // Marked as on no remote yet, where the list can't say so with the
  // remote's line (the unpushed commits aren't one run).
  unpushed?: boolean;
}) {
  const nav = useWorktreeNav();
  const selected = useRowSelection(`commit:${commit.hash}`);
  const items = (
    <CommitMenuItems
      worktree={worktree}
      commit={commit}
      rewrite={rewrite}
      actions={actions}
    />
  );
  const row = (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={() =>
        nav.toCommit(worktree.projectId, worktree.id, commit.hash, true)
      }
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span
        className={cn(
          "w-full truncate text-sm group-hover/commit:pr-6 group-has-data-popup-open/commit:pr-6",
          faded && "text-muted-foreground",
        )}
      >
        {commit.subject}
      </span>
      <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1 truncate">
          {unpushed && (
            <CloudOff aria-label="Not pushed yet" className="size-3 shrink-0" />
          )}
          <RelativeDate date={commit.date} />
        </span>
        {(commit.additions > 0 || commit.deletions > 0) && (
          <span className="ml-auto">
            <DiffStats
              additions={commit.additions}
              deletions={commit.deletions}
            />
          </span>
        )}
      </span>
    </button>
  );
  if (!menu) {
    return (
      <div
        className={cn(
          "rounded-md transition-colors",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
      >
        {row}
      </div>
    );
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              "group/commit relative rounded-md transition-colors",
              selected
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50 has-data-popup-open:bg-accent/50",
            )}
          />
        }
      >
        {row}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${commit.hash}`}
            data-icon-button
            className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/commit:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-popup-open:opacity-100 phone:opacity-100"
          >
            <Ellipsis aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-52">
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">{items}</ContextMenuContent>
    </ContextMenu>
  );
}

// A commit's moves, for its "⋯" and its right click alike. The ones that
// rewrite it only while no remote has it (lib/commitRewrite).
function CommitMenuItems({
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
        <DropdownMenuItem disabled={busy} onClick={() => actions.undoTo(undo)}>
          <Undo2 />
          {canAmend
            ? "Undo this commit"
            : `Undo the ${pluralize(undo.count, "commit")} above`}
          <span className="text-muted-foreground">(keeps changes)</span>
        </DropdownMenuItem>
      )}
      {(canAmend || reword || squash || undo) && <DropdownMenuSeparator />}
      {actions.canRevert && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => actions.revert(commit)}
        >
          <RotateCcw />
          Revert
        </DropdownMenuItem>
      )}
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
