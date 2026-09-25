import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// The chip shape, shared by the quiet action chip below and the
// read-only chips that name a fact (a project a device hosts, a live
// port forward). One string, so the ring and padding of a chip exist
// once and doubutsu's data-slot fill lands on the same box everywhere.
const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ring-1 ring-border ring-inset";

// Non-interactive chip: names something, does nothing.
export function Chip({ className, ...props }: ComponentProps<"span">) {
  return (
    <span data-slot="chip" className={cn(CHIP_CLASS, className)} {...props} />
  );
}

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
        CHIP_CLASS,
        "text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
