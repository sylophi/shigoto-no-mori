import { ArrowLeft } from "lucide-react";
import { Button } from "./button.tsx";
import { cn } from "../lib/utils.ts";
import { SimpleTooltip } from "./tooltip.tsx";

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
      // Negative margin keeps the label aligned with the header column.
      // The ghost fill only shows on hover, on a phone too: this opts
      // out of the resting fill there (phone.css). Escape finds it by
      // this too (useEscapeGoesBack).
      data-back-button
      className={cn(
        "-ml-2 w-fit max-w-full gap-1 text-xs font-normal text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <ArrowLeft aria-hidden className="size-3" />
      <SimpleTooltip whenTruncated tip={label}>
        <span className="min-w-0 truncate">{label}</span>
      </SimpleTooltip>
    </Button>
  );
}
