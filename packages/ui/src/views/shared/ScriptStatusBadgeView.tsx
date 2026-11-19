import { Loader2 } from "lucide-react";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { useNow } from "../../hooks/useNow.ts";
import { formatRelativeTime } from "../../lib/relativeTime.ts";
import type { ScriptRunState } from "../../lib/scriptRun.ts";

interface ScriptStatusBadgeProps {
  state: ScriptRunState;
}

export function ScriptStatusBadgeView({ state }: ScriptStatusBadgeProps) {
  const now = useNow();

  if (state.cancelling) {
    // Genuinely waiting (SIGTERM grace before SIGKILL), so spinner is
    // honest here. Active runs use a pulsing dot below.
    return (
      <Indicator
        tone="muted"
        mark={<Loader2 aria-hidden className="size-3 animate-spin" />}
      >
        Stopping…
      </Indicator>
    );
  }
  if (state.status === "starting") {
    return (
      <Indicator tone="muted" mark={LIVE_DOT}>
        Starting…
      </Indicator>
    );
  }
  if (state.status === "running") {
    return (
      <Indicator tone="foreground" mark={LIVE_DOT}>
        Running
      </Indicator>
    );
  }
  if (state.status === "exited") {
    const when = state.endedAt;
    const timeTip = when ? new Date(when).toLocaleString() : undefined;
    const time = when !== null && (
      <span className="ml-2 text-muted-foreground">
        {formatRelativeTime(when, now)}
      </span>
    );
    // exitCode === null happens when the process was killed by signal
    // (the user clicked Stop, the app quit, or the worktree was
    // removed). That's intentional cancellation, not a failure, so
    // colour and copy match the muted "done" treatment.
    if (state.exitCode === null || state.exitCode === 0) {
      return (
        <SimpleTooltip tip={timeTip}>
          <span className="tabular shrink-0 text-xs text-muted-foreground select-text">
            {state.exitCode === null ? "Stopped" : "Done"}
            {time}
          </span>
        </SimpleTooltip>
      );
    }
    return (
      <SimpleTooltip tip={timeTip}>
        <span className="tabular shrink-0 text-xs text-destructive select-text">
          Failed with exit {state.exitCode}
          {time}
        </span>
      </SimpleTooltip>
    );
  }
  if (state.status === "errored") {
    return (
      <span className="shrink-0 text-xs text-destructive select-text">
        Errored
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
  tone,
  mark,
  children,
}: {
  tone: "muted" | "foreground";
  mark: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs",
        tone === "muted" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {mark}
      {children}
    </span>
  );
}
