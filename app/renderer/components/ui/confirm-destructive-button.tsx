import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ConfirmDestructiveButtonProps {
  armed: boolean;
  pending: boolean;
  pendingLabel: string;
  idleLabel: string;
  onClick: () => void;
  // Off for a reason other than the removal under way.
  disabled?: boolean;
}

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
}: ConfirmDestructiveButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline-destructive"
      disabled={pending || disabled}
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
          <Trash2 aria-hidden className="size-3.5" />
          {idleLabel}
        </>
      )}
    </Button>
  );
}
