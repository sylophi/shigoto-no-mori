import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  // Shown as a native tooltip on the option button.
  title?: string;
}

// The house few-way toggle: pill options on an inset track (new-worktree
// mode, carry-over mode, diff layout). One source of truth for the
// track + selection treatment; call sites only pass sizing. The
// data-slot doubles as the doubutsu hook -- the overlay fills the track
// with the --input tray tint once borders are stripped.
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  optionClassName,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  disabled?: boolean;
  className?: string;
  // Sizing knobs only; color/selection stays uniform across call sites.
  optionClassName?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="segmented-control"
      className={cn(
        "inline-flex shrink-0 rounded-md border border-input p-0.5",
        className,
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          title={opt.title}
          aria-pressed={value === opt.value}
          className={cn(
            // Concentric with the track: the option radius is the
            // rounded-md outer radius (--radius * 0.8) minus the p-0.5
            // track padding, so it stays correct when a theme scales
            // --radius (doubutsu bumps it to 1rem).
            "inline-flex items-center gap-1 rounded-[calc(var(--radius)*0.8-2px)] transition-colors",
            optionClassName ?? "px-3 py-1 text-xs",
            value === opt.value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
