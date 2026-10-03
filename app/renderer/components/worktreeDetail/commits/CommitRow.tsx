import { Copy, PencilLine, Undo2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useNow } from "@/hooks/ui/useNow";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { CommitRewrite } from "@/lib/commitRewrite";
import { pluralize } from "@/lib/pluralize";
import type { CommitSummary, Worktree } from "@shared/schemas";
import { CommitRowView } from "./CommitRowView";

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
  const now = useNow();
  const onClick = () => {
    onNavigate?.();
    nav.toCommit(worktree.projectId, worktree.id, commit.hash);
  };

  const row = (
    <CommitRowView
      commit={commit}
      now={now}
      dateTitle={new Date(commit.date).toLocaleString()}
      onClick={onClick}
    />
  );

  // Rewriting is only offered for commits no remote has: HEAD can be
  // amended, and a run of local commits can be undone back to a row
  // with a soft reset, so their changes come back staged. Rows past
  // that line get the plain menu.
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
