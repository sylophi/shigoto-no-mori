import { Loader2 } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { SyncTone } from "@/lib/syncState";
import { cn } from "@/lib/utils";

// Tone-to-class lookup. Spelled out so Tailwind's JIT keeps the classes
// in the build instead of pruning the dynamic interpolation.
const TONE_CLASSES: Record<SyncTone, string> = {
  violet:
    "text-violet-500 hover:bg-violet-500/10 focus-visible:outline-violet-500",
  emerald:
    "text-emerald-500 hover:bg-emerald-500/10 focus-visible:outline-emerald-500",
  sky: "text-sky-500 hover:bg-sky-500/10 focus-visible:outline-sky-500",
  indigo:
    "text-indigo-500 hover:bg-indigo-500/10 focus-visible:outline-indigo-500",
  rose: "text-rose-500 hover:bg-rose-500/10 focus-visible:outline-rose-500",
};

// The pill's shape without its tone or its button behaviour, for a
// status that stands where an action would (a pull held back, "Up to
// date"), so the two line up when one takes the other's place.
export const SYNC_PILL_SHAPE =
  "tabular inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-xs";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

interface SyncActionButtonProps {
  tone: SyncTone;
  icon?: IconType;
  label: string;
  tip?: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function SyncActionButtonView({
  tone,
  icon: Icon,
  label,
  tip,
  pending,
  disabled,
  onClick,
}: SyncActionButtonProps) {
  const DisplayIcon = pending ? Loader2 : Icon;
  return (
    <SimpleTooltip tip={tip}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className={cn(
          SYNC_PILL_SHAPE,
          "transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
          TONE_CLASSES[tone],
        )}
      >
        {label}
        {DisplayIcon && (
          <DisplayIcon
            aria-hidden
            className={cn("size-3.5", pending && "animate-spin")}
          />
        )}
      </button>
    </SimpleTooltip>
  );
}
