import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
  const compact = variant === "row";
  const iconSize = compact ? "size-3" : "size-3.5";
  const gap = compact ? "gap-1" : "gap-1.5";

  if (state.cancelling) {
    // Genuinely waiting (SIGTERM grace before SIGKILL), so spinner is
    // honest here. Active runs use a pulsing dot below.
    return (
      <Spinner gap={gap} icon={iconSize} tone="muted">
        Stopping…
      </Spinner>
    );
  }
  if (state.status === "starting") {
    return (
      <LiveDot gap={gap} tone="muted">
        Starting…
      </LiveDot>
    );
  }
  if (state.status === "running") {
    return (
      <LiveDot gap={gap} tone="foreground">
        Running
      </LiveDot>
    );
  }
  if (state.status === "exited") {
    const when = state.endedAt;
    const timeTitle = when ? new Date(when).toLocaleString() : undefined;
    const suffix = when !== null ? ` · ${formatRelativeTime(when)}` : "";
    // exitCode === null happens when the process was killed by signal
    // (the user clicked Stop, the app quit, or the worktree was
    // removed). That's intentional cancellation, not a failure, so
    // colour and copy match the muted "done" treatment.
    if (state.exitCode === null) {
      return (
        <span
          className="tabular shrink-0 text-xs text-muted-foreground"
          title={timeTitle}
        >
          stopped{suffix}
        </span>
      );
    }
    if (state.exitCode === 0) {
      return (
        <span
          className="tabular shrink-0 text-xs text-muted-foreground"
          title={timeTitle}
        >
          done{suffix}
        </span>
      );
    }
    return (
      <span
        className="tabular shrink-0 font-mono text-xs text-destructive"
        title={timeTitle}
      >
        failed · exit {state.exitCode}
        <span className="font-sans text-muted-foreground">{suffix}</span>
      </span>
    );
  }
  if (state.status === "errored") {
    return (
      <span className="shrink-0 text-xs text-destructive">errored</span>
    );
  }
  return null;
}

function Spinner({
  gap,
  icon,
  tone,
  children,
}: {
  gap: string;
  icon: string;
  tone: "muted" | "foreground";
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
      <Loader2 aria-hidden className={cn(icon, "animate-spin")} />
      {children}
    </span>
  );
}

function LiveDot({
  gap,
  tone,
  children,
}: {
  gap: string;
  tone: "muted" | "foreground";
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
      <span
        aria-hidden
        className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-500"
      />
      {children}
    </span>
  );
}
