import { X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

// The close control on a villager's dialogue box or letter, which draw
// their own card and so their own close. Place it with `className`.
export function CloseButton({
  onClose,
  className,
}: {
  onClose: () => void;
  className?: string;
}) {
  return (
    <IconButton
      aria-label="Close"
      onClick={onClose}
      className={cn("absolute rounded-full", className)}
    >
      <X aria-hidden className="size-3" />
    </IconButton>
  );
}
