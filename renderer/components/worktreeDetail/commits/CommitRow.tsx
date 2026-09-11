import { ChevronRight, Copy, PencilLine, Undo2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DiffStats } from "@/components/ui/diff-stats";
import { RelativeDate } from "@/components/ui/relative-date";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CommitRewrite } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import type { CommitSummary, Worktree } from "@shared/schemas";

interface CommitRowProps {
  worktree: Worktree;
  commit: CommitSummary;
  // What the list allows for this row (lib/commitRewrite). The list
  // knows the neighbours, the row doesn't.
  rewrite: CommitRewrite;
  // The list's one undo action (see useUndoCommits), shared across rows
  // rather than subscribed to by each.
  onUndo: (target: string, count: number, head: string) => void;
  undoPending: boolean;
  onNavigate?: () => void;
}

export function CommitRow({
  worktree,
  commit,
  rewrite,
  onUndo,
  undoPending,
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
      title="View this commit's diff"
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
  // amended, and any run of local commits can be undone back to a row
  // (soft reset -- their changes come back staged). Rows past that line
  // get the plain menu.
  const { canAmend, undo } = rewrite;

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
        {(canAmend || undo) && <DropdownMenuSeparator />}
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
        {undo && (
          <DropdownMenuItem
            disabled={undoPending}
            onClick={() => onUndo(undo.target, undo.count, undo.head)}
          >
            <Undo2 />
            {canAmend
              ? "Undo this commit"
              : `Undo the ${pluralize(undo.count, "newer commit")}`}
            <span className="text-muted-foreground">(keeps changes)</span>
          </DropdownMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
