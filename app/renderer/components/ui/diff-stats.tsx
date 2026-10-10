import { cn } from "@/lib/utils";

// green-500 / rose-500 read close to Pierre's dark/light addition
// and deletion hues without requiring shadow-DOM theme variables.
// Green, not emerald, which follows the palette's accent.
//
// `compact` is a list's (files, commits): a step smaller, and a side
// with nothing on it left out (a new file is all additions, and "−0"
// says nothing).
export function DiffStats({
  additions,
  deletions,
  compact = false,
}: {
  additions: number;
  deletions: number;
  compact?: boolean;
}) {
  const label = `${additions} additions, ${deletions} deletions`;
  return (
    <span
      aria-label={label}
      className={cn(
        "tabular inline-flex shrink-0 items-center font-mono",
        compact ? "gap-1 text-2xs" : "gap-1.5 text-xs",
      )}
    >
      {(!compact || additions > 0) && (
        <span className="text-green-500">+{additions}</span>
      )}
      {(!compact || deletions > 0) && (
        <span className="text-rose-500">−{deletions}</span>
      )}
    </span>
  );
}
