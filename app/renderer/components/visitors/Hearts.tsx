import { cn } from "@/lib/utils";
import { FRIENDSHIP } from "@/lib/villagers/visitors";

// A villager's friendship as a row of hearts, one per level
// (lib/villagers/visitors.ts), the ones reached filled in.
export function Hearts({
  filled,
  className,
}: {
  filled: number;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("flex gap-0.5", className)}>
      {FRIENDSHIP.map((level, index) => (
        <svg
          key={level.title}
          viewBox="0 0 12 11"
          className={cn(
            "size-3",
            index < filled ? "fill-rose-400" : "fill-muted-foreground/20",
          )}
        >
          <path d="M6 10.6C2.6 7.9.6 6 .6 3.7.6 1.9 2 .6 3.6.6c1 0 1.9.5 2.4 1.3C6.5 1.1 7.4.6 8.4.6c1.6 0 3 1.3 3 3.1 0 2.3-2 4.2-5.4 6.9Z" />
        </svg>
      ))}
    </span>
  );
}
