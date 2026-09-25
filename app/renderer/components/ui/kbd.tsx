import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
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

export function KbdGroup({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  );
}

// A key hint in a footer row: the keys, then what they do.
export function KbdHint({ keys, label }: { keys: ReactNode[]; label: string }) {
  return (
    <KbdGroup>
      {keys.map((key, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a fixed list, never reordered
        <Kbd key={index}>{key}</Kbd>
      ))}
      <span className="text-muted-foreground/80">{label}</span>
    </KbdGroup>
  );
}
