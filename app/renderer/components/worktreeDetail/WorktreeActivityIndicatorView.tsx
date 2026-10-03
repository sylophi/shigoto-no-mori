import { Loader2 } from "lucide-react";

// The header's "Fetching refs…" line beside the branch title, drawn by
// WorktreeActivityIndicator while a refresh runs. Nothing when idle.
export function WorktreeActivityIndicatorView({
  label,
}: {
  label: string | null;
}) {
  if (label === null) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 self-center text-xs text-muted-foreground/70 italic">
      <Loader2 aria-hidden className="size-3 animate-spin" />
      {label}
    </span>
  );
}
