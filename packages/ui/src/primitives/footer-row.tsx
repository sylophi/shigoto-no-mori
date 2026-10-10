import type React from "react";
import { cn } from "../lib/utils.ts";

// A popup's footer: its key hints and its actions in a muted band
// under a rule (v1), or a muted fill (doubutsu, by the data-slot).
export function FooterRow({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="footer-row"
      className={cn(
        "flex items-center gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
