import type React from "react";
import { cn } from "../lib/utils.ts";
import type { WithoutTitle } from "./tooltip.tsx";

const TONE_CLASS = {
  default: "hover:bg-accent hover:text-foreground",
  destructive: "hover:bg-destructive/10 hover:text-destructive",
};

const SIZE_CLASS = {
  default: "p-1",
  // A diff's file header and index, where the row is barely taller.
  xs: "inline-flex size-5 shrink-0 items-center justify-center rounded-sm",
};

// Hidden until its row is hovered or it takes focus: the caller adds
// the row's group-hover. Always shown in the phone layout, where
// nothing hovers.
const REVEAL_CLASS =
  "shrink-0 text-muted-foreground/50 opacity-0 transition-opacity focus-visible:opacity-100 phone:opacity-100";

// The bare icon button a row wears (rename, remove, back): quieter and
// smaller than ui/button.tsx's icon sizes, with a fill only on hover.
// data-icon-button is the phone layout's hook for a resting fill, since
// nothing hovers there (phone.css). An attribute of its own rather than
// a data-slot, which a menu trigger rendering this would overwrite.
// As a toggle (aria-pressed), the on state keeps the fill at rest.
export function IconButton({
  tone = "default",
  size = "default",
  reveal = false,
  className,
  ...props
}: WithoutTitle<React.ComponentProps<"button">> & {
  tone?: keyof typeof TONE_CLASS;
  size?: keyof typeof SIZE_CLASS;
  reveal?: boolean;
}) {
  return (
    <button
      type="button"
      data-icon-button
      className={cn(
        "rounded-md text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground",
        SIZE_CLASS[size],
        TONE_CLASS[tone],
        reveal && REVEAL_CLASS,
        className,
      )}
      {...props}
    />
  );
}
