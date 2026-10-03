// A script's cell in the Scripts section as drawn (ScriptRow.tsx runs
// it): run or stop on the left, and once a run has landed, its status
// and the way to its output on the right.
import type { ReactNode } from "react";
import { ChevronRight, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";

export function ScriptRowView({
  label,
  command,
  busy = false,
  disabled = false,
  disabledReason,
  status = null,
  onToggle,
  onOpenConsole,
}: {
  label: string;
  command: string;
  // Running or starting: the button stops it.
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  // The last run's status (ScriptStatusBadge), null before any run.
  status?: ReactNode;
  onToggle?: () => void;
  onOpenConsole?: () => void;
}) {
  const actionLabel = busy ? `Stop ${label}` : `Run ${label}`;
  return (
    <div className={cn("flex items-stretch text-xs")}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-label={actionLabel}
        title={
          disabledReason ??
          (command ? `${actionLabel}\n${command}` : actionLabel)
        }
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          busy ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent",
        )}
      >
        {busy ? (
          <Square aria-hidden className="size-3 shrink-0" />
        ) : (
          <Play aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      </button>

      {/* Capped at half the row so a long status (a failed run's exit
          code and age) in a narrow grid column truncates instead of
          squeezing the script's name out. */}
      {status !== null && (
        <button
          type="button"
          onClick={onOpenConsole}
          aria-label={`View ${label} output`}
          title="View output"
          className="flex max-w-1/2 min-w-0 items-center gap-2 border-l border-border px-2.5 py-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="min-w-0 truncate">{status}</span>
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        </button>
      )}
    </div>
  );
}
