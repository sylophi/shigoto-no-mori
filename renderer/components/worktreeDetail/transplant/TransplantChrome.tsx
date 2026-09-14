// The transplant dialog's frame pieces, shared by its three steps so
// the rail, the scroll body and the footer band read the same from
// review to finish. The mirror dialog (../mirror/) wears the same
// frame with its own step names.
import { Check, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatElapsed } from "./transplantSteps";

const TRANSPLANT_STEPS = [
  "Review & destination",
  "Transplant",
  "Finish up source",
] as const;

export function StepRail({
  current,
  steps = TRANSPLANT_STEPS,
  label = "Transplant steps",
}: {
  current: number;
  steps?: readonly string[];
  label?: string;
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
                "flex size-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-semibold",
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

// The dialog's header: a tinted icon square, the title, one line
// under it, and either the close button or (once the attempt runs)
// its clock in the same corner.
export function FlowHeader({
  tint,
  icon: Icon,
  spin = false,
  title,
  children,
  elapsed,
  onClose,
}: {
  tint: string;
  icon: LucideIcon;
  spin?: boolean;
  title: ReactNode;
  children: ReactNode;
  elapsed?: { ms: number; label: "elapsed" | "total" };
  onClose: () => void;
}) {
  return (
    <header className="flex items-start gap-3 px-5 py-4">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          tint,
        )}
      >
        <Icon className={cn("size-4", spin && "animate-spin")} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="text-xs text-muted-foreground">{children}</div>
      </div>
      {elapsed === undefined ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={onClose}
        >
          <X />
        </Button>
      ) : (
        <div className="shrink-0 text-right leading-tight">
          <p className="font-mono text-lg font-semibold tabular-nums">
            {formatElapsed(elapsed.ms)}
          </p>
          <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
            {elapsed.label}
          </p>
        </div>
      )}
    </header>
  );
}

export function TransplantBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
  );
}

export function TransplantFooter({
  note,
  children,
}: {
  note: ReactNode;
  children?: ReactNode;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/30 px-5 py-3">
      <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
        {note}
      </p>
      {children && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {children}
        </div>
      )}
    </footer>
  );
}

export const MAX_LIST_ROWS = 8;

// The dialogs' file lists (changed, staying behind, carry-over, the
// mirror's exclusions) share one card: a bordered monospace list
// showing the first MAX_LIST_ROWS entries and counting the rest.
export const CARD = "rounded-lg border border-border bg-card p-3";
export const CARD_NOTE = `${CARD} text-xs text-muted-foreground`;

export function CardList({
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

export function CardSkeleton({ rows = 1 }: { rows?: 1 | 2 }) {
  return (
    <div className={`${CARD} space-y-1.5`}>
      {rows === 2 && <Skeleton className="h-3.5 w-3/4" />}
      <Skeleton className="h-3.5 w-1/2" />
    </div>
  );
}

// The titled, tinted "what happens" note. Info-toned only: failures
// go through the shared ErrorBanner.
export function NoteBox({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-sky-500/10 p-3 text-xs">
      <p className="text-sm font-medium text-sky-700 dark:text-sky-300">
        {title}
      </p>
      <div className="mt-1.5 space-y-1 text-foreground/80">{children}</div>
    </div>
  );
}
