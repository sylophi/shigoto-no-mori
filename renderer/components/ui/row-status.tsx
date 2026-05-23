import { Check, Loader2, X } from "lucide-react";

export type RowStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "error"; message: string };

interface RowStatusBadgeProps {
  status: RowStatus;
  // aria-label per state so screen readers describe the action in
  // progress (e.g. "Moving" / "Converting"). Pages that don't override
  // get a neutral default.
  labels?: { running?: string; done?: string; error?: string };
}

export function RowStatusBadge({ status, labels }: RowStatusBadgeProps) {
  if (status.kind === "running") {
    return (
      <Loader2
        aria-label={labels?.running ?? "Working"}
        className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground"
      />
    );
  }
  if (status.kind === "done") {
    return (
      <Check
        aria-label={labels?.done ?? "Done"}
        className="mt-1 size-4 shrink-0 text-emerald-500"
      />
    );
  }
  if (status.kind === "error") {
    return (
      <X
        aria-label={labels?.error ?? "Failed"}
        className="mt-1 size-4 shrink-0 text-destructive"
      />
    );
  }
  return null;
}
