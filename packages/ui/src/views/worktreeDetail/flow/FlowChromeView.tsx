// What a multi-step worktree dialog adds to the dialog's bands
// (primitives/dialog.tsx): the step rail and the card styles. The
// transplant and the mirror (../transplant/, ../mirror/) walk them
// through PullFlow.tsx. LandedPath (FlowChrome.tsx) reads the landing
// machine's home.
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "../../../primitives/skeleton.tsx";
import { cn } from "../../../lib/utils.ts";

export function StepRailView({
  current,
  steps,
  label,
}: {
  current: number;
  steps: readonly string[];
  label: string;
}) {
  return (
    <ol
      aria-label={label}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/30 px-5 py-2 text-xs"
    >
      {steps.map((step, index) => {
        const state =
          index < current ? "done" : index === current ? "current" : "next";
        return (
          <li
            key={step}
            aria-current={state === "current" ? "step" : undefined}
            className="flex items-center gap-2"
          >
            {index > 0 && (
              <span aria-hidden className="text-muted-foreground/40">
                ›
              </span>
            )}
            <span
              aria-hidden
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full font-mono text-4xs font-semibold",
                state === "next"
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary text-primary-foreground",
              )}
            >
              {state === "done" ? <Check className="size-2.5" /> : index + 1}
            </span>
            <span
              className={cn(
                state === "next" ? "text-muted-foreground" : "font-medium",
              )}
            >
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export const MAX_LIST_ROWS = 8;

// The dialogs' file lists (changed, carry-over) share one card: a
// bordered monospace list showing the first MAX_LIST_ROWS entries and
// counting the rest. A list of another shape takes CARD directly.
export const CARD = "rounded-lg border border-border bg-card p-3";
export const CARD_NOTE = `${CARD} text-xs text-muted-foreground`;

export function CardListView({
  total,
  children,
}: {
  total: number;
  children: ReactNode;
}) {
  return (
    <ul className={`${CARD} space-y-1 font-mono text-xs`}>
      {children}
      {total > MAX_LIST_ROWS && (
        <li className="text-muted-foreground">
          and {total - MAX_LIST_ROWS} more
        </li>
      )}
    </ul>
  );
}

export function CardSkeletonView({ rows = 1 }: { rows?: 1 | 2 }) {
  return (
    <div className={`${CARD} space-y-1.5`}>
      {rows === 2 && <Skeleton className="h-3.5 w-3/4" />}
      <Skeleton className="h-3.5 w-1/2" />
    </div>
  );
}
