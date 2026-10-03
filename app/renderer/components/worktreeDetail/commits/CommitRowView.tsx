// A commit in the branch's list as drawn (CommitRow.tsx opens it and
// hangs the rewrite menu off it): subject, hash, author, age and the
// diff stats. Props pass through to the button, so a menu trigger can
// render it as its own element.
import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DiffStats } from "@/components/ui/diff-stats";
import type { CommitSummary } from "@shared/schemas";

export function CommitRowView({
  commit,
  age,
  ...props
}: {
  commit: CommitSummary;
  // How long ago it was made: RelativeDate, which follows the clock on
  // its own so a tick redraws it alone, or RelativeDateView for a
  // picture.
  age: ReactNode;
} & ComponentProps<"button">) {
  return (
    <button
      type="button"
      title="View this commit's diff"
      className="-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
      {...props}
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
          {age}
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
}
