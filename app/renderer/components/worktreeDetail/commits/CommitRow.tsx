import {
  ChevronRight,
  Combine,
  Copy,
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { DiffStats } from "@/components/ui/diff-stats";
import { RelativeDate } from "@/components/ui/relative-date";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CommitRewrite } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import type { CommitSummary, Worktree } from "@shared/schemas";
import type { CommitActions } from "./useCommitActions";

interface CommitRowProps {
  worktree: Worktree;
  commit: CommitSummary;
  // What the list allows for this row (lib/commitRewrite). The list
  // knows the neighbours, the row doesn't.
  rewrite: CommitRewrite;
  // The list's one set of menu actions (useCommitActions), shared
  // across rows rather than subscribed to by each.
  actions: CommitActions;
  onNavigate?: () => void;
}

export function CommitRow({
  worktree,
  commit,
  rewrite,
  actions,
  onNavigate,
}: CommitRowProps) {
  const nav = useWorktreeNav();
  const onClick = () => {
    onNavigate?.();
    nav.toCommit(worktree.projectId, worktree.id, commit.hash);
  };

  const row = (
    <button
      type="button"
      onClick={onClick}
      className="-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="w-full truncate text-sm">{commit.subject}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{commit.hash}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span>{commit.author}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <RelativeDate date={commit.date} />
        </div>
      </div>
      {(commit.additions > 0 || commit.deletions > 0) && (
        <DiffStats additions={commit.additions} deletions={commit.deletions} />
      )}
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/40"
      />
    </button>
  );

  // Rewriting is only offered for commits no remote has: HEAD can be
  // amended, any of them reworded or squashed into the one before, and
  // a run of them undone back to a row with a soft reset, so their
  // changes come back staged. Rows past that line get the moves that
  // only add commits.
  const { canAmend, undo, reword, squash } = rewrite;
  const busy = actions.pending;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        <DropdownMenuItem
          onClick={() => void navigator.clipboard.writeText(commit.hash)}
        >
          <Copy />
          Copy hash
        </DropdownMenuItem>
        {(canAmend || reword || squash || undo) && <DropdownMenuSeparator />}
        {canAmend && (
          <DropdownMenuItem
            onClick={() => {
              onNavigate?.();
              nav.toDiff(worktree.projectId, worktree.id, { amend: true });
            }}
          >
            <PencilLine />
            Amend this commit…
          </DropdownMenuItem>
        )}
        {reword && (
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
            Squash into the commit before
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
              : `Undo the ${pluralize(undo.count, "newer commit")}`}
            <span className="text-muted-foreground">(keeps changes)</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={busy}
          onClick={() => actions.revert(commit)}
        >
          <RotateCcw />
          Revert
        </DropdownMenuItem>
        {actions.pickTargets.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={busy}>
              <GitBranchPlus />
              Cherry-pick onto
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
          onClick={() => {
            onNavigate?.();
            actions.newWorktreeFrom(commit);
          }}
        >
          <FolderGit2 />
          New worktree from here
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
