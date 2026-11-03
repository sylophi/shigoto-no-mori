import type React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "./button.tsx";
import { SimpleTooltip } from "./tooltip.tsx";

type ButtonProps = React.ComponentProps<typeof Button>;

interface ConfirmDestructiveButtonProps {
  armed: boolean;
  pending: boolean;
  pendingLabel: string;
  idleLabel: string;
  armedLabel?: string;
  onClick: () => void;
  // Off for a reason other than the removal under way. `disabledReason`
  // names one and doubles as the tooltip.
  disabled?: boolean;
  disabledReason?: string;
  // The button's mark, armed or not: a bin unless the act is not a
  // removal (the Live page's Stop all takes the stop square).
  icon?: React.ReactNode;
  // A hint that leaves the button live, where disabledReason would not.
  tip?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  // For a split button's half (ClosedPullRequestBox).
  className?: string;
}

const BIN = <Trash2 aria-hidden className="size-3.5" />;

// Two-step "arm then confirm" button: a spinner while pending, else
// its icon beside the idle or the armed label.
export function ConfirmDestructiveButton({
  armed,
  pending,
  pendingLabel,
  idleLabel,
  armedLabel = "Click again to confirm",
  onClick,
  disabled = false,
  disabledReason,
  icon = BIN,
  tip,
  variant = "outline-destructive",
  size = "sm",
  className,
}: ConfirmDestructiveButtonProps) {
  return (
    <SimpleTooltip tip={disabledReason ?? tip}>
      <Button
        type="button"
        size={size}
        variant={variant}
        disabled={pending || disabled || disabledReason !== undefined}
        aria-pressed={armed}
        onClick={onClick}
        className={className}
      >
        {pending ? (
          <>
            <Loader2 aria-hidden className="animate-spin" />
            {pendingLabel}
          </>
        ) : (
          <>
            {icon}
            {armed ? armedLabel : idleLabel}
          </>
        )}
      </Button>
    </SimpleTooltip>
  );
}
