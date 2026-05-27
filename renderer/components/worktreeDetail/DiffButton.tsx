import { ChevronRight } from "lucide-react";
import { DiffStats } from "@/components/ui/diff-stats";

export function DiffButton({
  changedFiles,
  additions,
  deletions,
  onClick,
}: {
  changedFiles: number;
  additions: number;
  deletions: number;
  onClick: () => void;
}) {
  const fileNoun = changedFiles === 1 ? "file" : "files";
  return (
    <button
      type="button"
      onClick={onClick}
      title="View pull request diff"
      className="tabular inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span>
        {changedFiles} {fileNoun} changed,
      </span>
      <DiffStats additions={additions} deletions={deletions} />
      <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-60" />
    </button>
  );
}
