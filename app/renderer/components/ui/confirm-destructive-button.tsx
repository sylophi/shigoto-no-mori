import type React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface ConfirmDestructiveButtonProps {
  armed: boolean;
  pending: boolean;
  pendingLabel: string;
  idleLabel: string;
  onClick: () => void;
  // Off for a reason other than the removal under way. `disabledReason`
  // names one and doubles as the tooltip.
  disabled?: boolean;
  disabledReason?: string;
  // The idle state's mark, a bin unless the act is not a removal (the
  // Live page's Stop all takes the stop square).
  icon?: React.ReactNode;
  // A hint that leaves the button live, where disabledReason would not.
  tip?: string;
}

const BIN = <Trash2 aria-hidden className="size-3.5" />;

// Two-step "arm then confirm" destructive button: outline styling
// with spinner-while-pending / "click again" / icon+label states. Used
// by the closed-PR and merged-primary cleanup boxes and the villager
// data's Remove.
export function ConfirmDestructiveButton({
  armed,
  pending,
  pendingLabel,
  idleLabel,
  onClick,
  disabled = false,
  disabledReason,
  icon = BIN,
  tip,
}: ConfirmDestructiveButtonProps) {
  return (
    <SimpleTooltip tip={disabledReason ?? tip}>
      <Button
        type="button"
        size="sm"
        variant="outline-destructive"
        disabled={pending || disabled || disabledReason !== undefined}
        aria-pressed={armed}
        onClick={onClick}
      >
        {pending ? (
          <>
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {pendingLabel}
          </>
        ) : armed ? (
          "Click again to confirm"
        ) : (
          <>
            {icon}
            {idleLabel}
          </>
        )}
      </Button>
    </SimpleTooltip>
  );
}
