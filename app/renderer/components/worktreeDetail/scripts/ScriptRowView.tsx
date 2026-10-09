import { ChevronRight, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScriptRunState } from "@/store/scriptRuns";
import { ScriptStatusBadgeView } from "@/components/shared/ScriptStatusBadgeView";
import { SimpleTooltip } from "@/components/ui/tooltip";

export function ScriptRowView({
  label,
  command,
  state,
  busy,
  canRun,
  disabledReason,
  onRun,
  onStop,
  onOpenConsole,
}: {
  label: string;
  command: string;
  // The script's last run, and whether one is under way.
  state: ScriptRunState;
  busy: boolean;
  canRun: boolean;
  disabledReason: string | undefined;
  onRun: () => void;
  onStop: () => void;
  // Its output, once it has run.
  onOpenConsole: () => void;
}) {
  const hasHistory = state.status !== "idle";
  const actionLabel = busy ? `Stop ${label}` : `Run ${label}`;

  return (
    <div className={cn("flex items-stretch text-xs")}>
      {/* The name over the command it runs: the name can be cut off in
          a narrow column. */}
      <SimpleTooltip
        tip={disabledReason ?? (command ? `${label}\n${command}` : undefined)}
      >
        <button
          type="button"
          onClick={busy ? onStop : onRun}
          disabled={state.cancelling || !canRun}
          aria-label={actionLabel}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            busy
              ? "text-destructive hover:bg-destructive/10"
              : "hover:bg-accent",
          )}
        >
          {busy ? (
            <Square aria-hidden className="size-3 shrink-0" />
          ) : (
            <Play
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
          )}
          <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
        </button>
      </SimpleTooltip>

      {/* Capped at half the row so a long status (a failed run's exit
          code and age) in a narrow grid column truncates instead of
          squeezing the script's name out. */}
      {hasHistory && (
        <button
          type="button"
          onClick={onOpenConsole}
          aria-label={`View ${label} output`}
          className="flex max-w-1/2 min-w-0 items-center gap-2 border-l border-border px-2.5 py-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="min-w-0 truncate">
            <ScriptStatusBadgeView state={state} />
          </span>
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        </button>
      )}
    </div>
  );
}
