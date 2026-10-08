import { GitCommitHorizontal, PencilLine, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RelativeDate } from "@/components/ui/relative-date";
import { SimpleTooltip } from "@/components/ui/tooltip";
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
  // One row, the subject first and cut where it has to be (its tooltip
  // finishes it), its age and the bare icon buttons after: the
  // sidebar's height is the file list's. The commit mark says what the
  // row is.
  return (
    <div
      data-slot="last-commit-strip"
      className="flex h-7 items-center gap-2 px-3"
    >
      <GitCommitHorizontal
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <SimpleTooltip whenTruncated tip={commit.subject}>
        <p className="min-w-0 flex-1 truncate text-xs select-text">
          {commit.subject}
        </p>
      </SimpleTooltip>
      <span className="shrink-0 text-2xs text-muted-foreground">
        <RelativeDate date={commit.date} />
      </span>
      {!amending && (
        <span className="flex shrink-0 items-center">
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
        </span>
      )}
    </div>
  );
}
