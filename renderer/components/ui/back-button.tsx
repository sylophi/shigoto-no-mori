import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function BackButton({
  onClick,
  label,
  className,
}: {
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      // Negative margin keeps the label aligned with the header column;
      // the ghost fill only shows on hover.
      className={cn(
        "-ml-2 w-fit gap-1 text-xs font-normal text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <ArrowLeft aria-hidden className="size-3" />
      <span>{label}</span>
    </Button>
  );
}
