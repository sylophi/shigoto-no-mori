import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BackButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      // Negative margin keeps the label aligned with the header column;
      // the ghost fill only shows on hover.
      className="-ml-2 w-fit gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft aria-hidden className="size-3" />
      <span>{label}</span>
    </Button>
  );
}
