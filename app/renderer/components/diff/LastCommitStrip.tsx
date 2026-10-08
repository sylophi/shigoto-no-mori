import { PencilLine, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RelativeDate } from "@/components/ui/relative-date";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { CommitSummary } from "@shigomori/contracts/schemas";

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
  // Two rows, so the subject gets the sidebar's whole width: beside the
  // buttons it would be cut to a word or two. The buttons are bare
  // icons for the same reason, their tooltips saying what they do.
  return (
    <div data-slot="last-commit-strip" className="flex flex-col px-3 py-1">
      <div className="flex min-h-6 items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          Last commit, <RelativeDate date={commit.date} />
        </p>
        {!amending && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onAmend}
              disabled={busy}
              aria-label="Amend the last commit"
            >
              <PencilLine />
            </Button>
            {canUndo && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onUndo}
                disabled={busy}
                aria-label="Undo the last commit"
              >
                <Undo2 />
              </Button>
            )}
          </>
        )}
      </div>
      <SimpleTooltip whenTruncated tip={commit.subject}>
        <p className="truncate text-xs select-text">{commit.subject}</p>
      </SimpleTooltip>
    </div>
  );
}
