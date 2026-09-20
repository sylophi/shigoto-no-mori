import type React from "react";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  default: "hover:bg-accent hover:text-foreground",
  destructive: "hover:bg-destructive/10 hover:text-destructive",
};

// The bare icon button a row wears (rename, remove, back): quieter and
// smaller than ui/button.tsx's icon sizes, with a fill only on hover.
// data-icon-button is the phone layout's hook for a resting fill, since
// nothing hovers there (phone.css). An attribute of its own rather than
// a data-slot, which a menu trigger rendering this would overwrite.
export function IconButton({
  tone = "default",
  className,
  ...props
}: React.ComponentProps<"button"> & { tone?: keyof typeof TONE_CLASS }) {
  return (
    <button
      type="button"
      data-icon-button
      className={cn(
        "rounded-md p-1 text-muted-foreground transition-colors",
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    />
  );
}
