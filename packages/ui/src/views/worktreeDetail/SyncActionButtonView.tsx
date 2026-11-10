import { Loader2, X } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { TONE_MARK } from "../../primitives/status-dot.tsx";

// The tones a worktree's sync state is drawn in (the app's lib/syncState).
export type SyncTone = "violet" | "emerald" | "sky" | "indigo" | "rose";

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
  // While it runs, a click stops it.
  onCancel?: () => void;
}

export function SyncActionButtonView({
  tone,
  icon: Icon,
  label,
  tip,
  pending,
  disabled,
  onClick,
  onCancel,
}: SyncActionButtonProps) {
  const cancels = pending && onCancel !== undefined;
  const DisplayIcon = pending ? Loader2 : Icon;
  return (
    <SimpleTooltip tip={cancels ? "Cancel" : tip}>
      <button
        type="button"
        // The second click of a double-click doesn't stop what the
        // first started.
        onClick={(event) => {
          if (!cancels) onClick();
          else if (event.detail < 2) onCancel();
        }}
        disabled={!cancels && (disabled || pending)}
        aria-label={cancels ? `Cancel: ${label}` : undefined}
        className={cn(
          SYNC_PILL_SHAPE,
          "group/sync transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
          TONE_MARK[tone],
          "hover:bg-current/10 focus-visible:outline-current",
        )}
      >
        {label}
        {DisplayIcon && (
          <DisplayIcon
            aria-hidden
            className={cn(
              "size-3.5",
              pending && "animate-spin",
              cancels &&
                "group-hover/sync:hidden group-focus-visible/sync:hidden",
            )}
          />
        )}
        {cancels && (
          <X
            aria-hidden
            className="hidden size-3.5 group-hover/sync:block group-focus-visible/sync:block"
          />
        )}
      </button>
    </SimpleTooltip>
  );
}
