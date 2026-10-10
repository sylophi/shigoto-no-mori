import type { ReactNode } from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { SimpleTooltip } from "./tooltip.tsx";
import { cn } from "../lib/utils.ts";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  // Shown as a tooltip on the option button.
  tip?: string;
  // The option's name for assistive tech when its label is an icon
  // alone: the tooltip is visual only.
  ariaLabel?: string;
  // Greys out this option alone (the control-level `disabled` greys out
  // all of them). For choices that exist but aren't available right now.
  // Pair it with `tip`, and say why somewhere the eye will land.
  disabled?: boolean;
}

// The house few-way toggle: pill options on an inset track (new-worktree
// mode, carry-over mode, diff layout). One source of truth for the
// track + selection treatment; call sites only pass sizing. The
// data-slot doubles as the doubutsu hook. The overlay fills the track
// with the --input tray tint once borders are stripped. A radio group
// (Base UI's): Tab reaches the picked option, and the arrows move the
// pick.
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
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled}
      aria-label={ariaLabel}
      data-slot="segmented-control"
      className={cn(
        "inline-flex shrink-0 rounded-md border border-input p-0.5",
        className,
      )}
    >
      {options.map((opt) => (
        <SimpleTooltip key={opt.value} tip={opt.tip}>
          <Radio.Root
            value={opt.value}
            nativeButton
            render={<button type="button" aria-label={opt.ariaLabel} />}
            disabled={disabled || opt.disabled}
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
              (disabled || opt.disabled) && "cursor-not-allowed opacity-50",
            )}
          >
            {opt.label}
          </Radio.Root>
        </SimpleTooltip>
      ))}
    </RadioGroup>
  );
}
