import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import type { WithoutTitle } from "./tooltip.tsx";

export function Kbd({
  className,
  ...props
}: WithoutTitle<ComponentProps<"kbd">>) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-sans text-2xs font-medium text-muted-foreground [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export function KbdGroup({
  className,
  ...props
}: WithoutTitle<ComponentProps<"kbd">>) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  );
}

// A key hint in a footer row: the keys, then what they do. The label
// sits beside the <kbd>, not in it: inside, it took the browser's
// monospace for keyboard input.
export function KbdHint({ keys, label }: { keys: ReactNode[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <KbdGroup>
        {keys.map((key, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a fixed list, never reordered
          <Kbd key={index}>{key}</Kbd>
        ))}
      </KbdGroup>
      <span className="text-muted-foreground/80">{label}</span>
    </span>
  );
}
