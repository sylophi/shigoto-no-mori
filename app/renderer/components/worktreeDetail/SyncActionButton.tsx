import { Loader2 } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

export type Tone = "violet" | "emerald" | "sky" | "indigo" | "rose";

// Tone-to-class lookup. Spelled out so Tailwind's JIT keeps the classes
// in the build instead of pruning the dynamic interpolation.
const TONE_CLASSES: Record<Tone, string> = {
  violet:
    "text-violet-500 hover:bg-violet-500/10 focus-visible:outline-violet-500",
  emerald:
    "text-emerald-500 hover:bg-emerald-500/10 focus-visible:outline-emerald-500",
  sky: "text-sky-500 hover:bg-sky-500/10 focus-visible:outline-sky-500",
  indigo:
    "text-indigo-500 hover:bg-indigo-500/10 focus-visible:outline-indigo-500",
  rose: "text-rose-500 hover:bg-rose-500/10 focus-visible:outline-rose-500",
};

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

interface SyncActionButtonProps {
  tone: Tone;
  icon?: IconType;
  label: string;
  title: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function SyncActionButton({
  tone,
  icon: Icon,
  label,
  title,
  pending,
  disabled,
  onClick,
}: SyncActionButtonProps) {
  const DisplayIcon = pending ? Loader2 : Icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      title={title}
      className={cn(
        "tabular inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-xs transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
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
  );
}
