import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

// A wait's placeholder (a skeleton, a "Reading file…") keeps out of
// sight for its first 200ms, so a read that answers sooner never
// flashes it, then fades in. The fade starts from @starting-style, so it
// plays once, as the placeholder is put on screen. The delay holds a
// skeleton's pulse back too.
export const SHOWS_LATE =
  "transition-opacity delay-200 duration-150 starting:opacity-0 motion-reduce:duration-0";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", SHOWS_LATE, className)}
      {...props}
    />
  );
}
