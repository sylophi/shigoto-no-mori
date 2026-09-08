import { PencilLine, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RelativeDate } from "@/components/ui/relative-date";
import type { CommitSummary } from "@shared/schemas";

// The commit HEAD is on, with the two things the changes page can do
// to it: fold the next commit into it, or take it apart again. Shown
// only while that commit is still local (see canRewriteCommits): once a
// remote has it, rewriting it is a force-push conversation, not a
// button. While an amend is underway the buttons step aside. The
// composer's own header carries the cancel.
export function LastCommitStrip({
  commit,
  amending,
  canUndo,
  busy,
  onAmend,
  onUndo,
}: {
  commit: CommitSummary;
  amending: boolean;
  // False for a root commit: there is nothing before it to reset to.
  canUndo: boolean;
  busy: boolean;
  onAmend: () => void;
  onUndo: () => void;
}) {
  return (
    <div
      data-slot="last-commit-strip"
      className="flex items-center gap-2 border-t border-border px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">
          Last commit, <RelativeDate date={commit.date} />
        </p>
        <p className="truncate text-xs" title={commit.subject}>
          {commit.subject}
        </p>
      </div>
      {!amending && (
        <>
          <Button
            variant="ghost"
            size="xs"
            onClick={onAmend}
            disabled={busy}
            title="Fold the next commit into this one, editing its message"
          >
            <PencilLine />
            Amend
          </Button>
          {canUndo && (
            <Button
              variant="ghost"
              size="xs"
              onClick={onUndo}
              disabled={busy}
              title="Undo this commit; its changes come back staged"
            >
              <Undo2 />
              Undo
            </Button>
          )}
        </>
      )}
    </div>
  );
}
