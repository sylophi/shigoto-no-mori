import { Loader2, Trash2, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ConfirmDestructiveButtonProps {
  armed: boolean;
  pending: boolean;
  pendingLabel: string;
  idleLabel: string;
  onClick: () => void;
}

// Two-step "arm then confirm" destructive button: outline styling
// with spinner-while-pending / "click again" / icon+label states. Used
// by the closed-PR and merged-primary cleanup boxes.
export function ConfirmDestructiveButton({
  armed,
  pending,
  pendingLabel,
  idleLabel,
  onClick,
}: ConfirmDestructiveButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={onClick}
      className={cn(
        "text-destructive hover:bg-destructive/10 hover:text-destructive",
        armed && "bg-destructive/10",
      )}
    >
      {renderContent({ armed, pending, pendingLabel, idleLabel })}
    </Button>
  );
}

function renderContent({
  armed,
  pending,
  pendingLabel,
  idleLabel,
}: Omit<ConfirmDestructiveButtonProps, "onClick">): ReactNode {
  if (pending) return withIcon(Loader2, pendingLabel, "animate-spin");
  if (armed) return "Click again to confirm";
  return withIcon(Trash2, idleLabel);
}

function withIcon(
  Icon: LucideIcon,
  label: string,
  iconClassName?: string,
): ReactNode {
  return (
    <>
      <Icon aria-hidden className={cn("size-3.5", iconClassName)} />
      {label}
    </>
  );
}
