import { ChevronRight, FileDiff } from "lucide-react";
import { DiffStats } from "@shigomori/ui/primitives/diff-stats.tsx";

// The way to a diff: the file icon and count, the lines it adds and
// takes, like the Branch section's changes button. `words={false}`
// keeps the number alone, for a row with no room to spare.
export function DiffButtonView({
  changedFiles,
  additions,
  deletions,
  onClick,
  words = true,
}: {
  changedFiles: number;
  additions: number;
  deletions: number;
  onClick: () => void;
  words?: boolean;
}) {
  const fileNoun = changedFiles === 1 ? "file" : "files";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${changedFiles} ${fileNoun} changed, ${additions} added, ${deletions} removed`}
      className="tabular inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <FileDiff aria-hidden className="size-3.5 shrink-0" />
      <span>
        {changedFiles}
        {words && ` ${fileNoun} changed`}
      </span>
      <DiffStats additions={additions} deletions={deletions} />
      <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-60" />
    </button>
  );
}
