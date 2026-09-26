import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/ui/useNow";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { ScriptRunState } from "@/store/scriptRuns";

interface ScriptStatusBadgeProps {
  state: ScriptRunState;
  // "row" = compact label rendered in the worktree's script list.
  // "header" = inline status sentence under the command on the
  // full-page console. Both are plain text; neither uses a chip.
  variant?: "row" | "header";
}

export function ScriptStatusBadge({
  state,
  variant = "row",
}: ScriptStatusBadgeProps) {
  const now = useNow();
  const compact = variant === "row";
  const iconSize = compact ? "size-3" : "size-3.5";
  const gap = compact ? "gap-1" : "gap-1.5";

  if (state.cancelling) {
    // Genuinely waiting (SIGTERM grace before SIGKILL), so spinner is
    // honest here. Active runs use a pulsing dot below.
    return (
      <Indicator
        gap={gap}
        tone="muted"
        mark={<Loader2 aria-hidden className={cn(iconSize, "animate-spin")} />}
      >
        Stopping…
      </Indicator>
    );
  }
  if (state.status === "starting") {
    return (
      <Indicator gap={gap} tone="muted" mark={LIVE_DOT}>
        Starting…
      </Indicator>
    );
  }
  if (state.status === "running") {
    return (
      <Indicator gap={gap} tone="foreground" mark={LIVE_DOT}>
        Running
      </Indicator>
    );
  }
  if (state.status === "exited") {
    const when = state.endedAt;
    const timeTitle = when ? new Date(when).toLocaleString() : undefined;
    const suffix = when !== null ? ` · ${formatRelativeTime(when, now)}` : "";
    // exitCode === null happens when the process was killed by signal
    // (the user clicked Stop, the app quit, or the worktree was
    // removed). That's intentional cancellation, not a failure, so
    // colour and copy match the muted "done" treatment.
    if (state.exitCode === null || state.exitCode === 0) {
      return (
        <span
          className="tabular shrink-0 text-xs text-muted-foreground select-text"
          title={timeTitle}
        >
          {state.exitCode === null ? "stopped" : "done"}
          {suffix}
        </span>
      );
    }
    return (
      <span
        className="tabular shrink-0 font-mono text-xs text-destructive select-text"
        title={timeTitle}
      >
        failed · exit {state.exitCode}
        <span className="font-sans text-muted-foreground">{suffix}</span>
      </span>
    );
  }
  if (state.status === "errored") {
    return (
      <span className="shrink-0 text-xs text-destructive select-text">
        errored
      </span>
    );
  }
  return null;
}

// The mark an active run leads with.
const LIVE_DOT = (
  <span
    aria-hidden
    className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-500"
  />
);

// An in-flight state: its mark (the stop spinner or the live dot) and
// its word.
function Indicator({
  gap,
  tone,
  mark,
  children,
}: {
  gap: string;
  tone: "muted" | "foreground";
  mark: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center text-xs",
        gap,
        tone === "muted" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {mark}
      {children}
    </span>
  );
}
