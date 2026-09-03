// The transplant dialog's frame pieces, shared by its three steps so
// the rail, the scroll body and the footer band read the same from
// review to finish.
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TRANSPLANT_STEPS = [
  "Review & destination",
  "Transplant",
  "Finish up source",
] as const;

export function StepRail({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol
      aria-label="Transplant steps"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/30 px-5 py-2 text-xs"
    >
      {TRANSPLANT_STEPS.map((label, index) => {
        const state =
          index < current ? "done" : index === current ? "current" : "next";
        return (
          <li
            key={label}
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
              {label}
            </span>
          </li>
        );
      })}
    </ol>
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
