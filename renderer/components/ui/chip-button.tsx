import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Quiet inline action chip (e.g. "Open in Finder" inside pickers).
// Reads as a control via its inset ring in v1; doubutsu restyles it
// through the data-slot hook.
export function ChipButton({
  className,
  type = "button",
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      data-slot="chip"
      type={type}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/80 ring-1 ring-border transition-colors ring-inset hover:bg-accent hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
