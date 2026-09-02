import { cn } from "@/lib/utils";

interface OnlyInWorktreesProps {
  inPrimary: boolean;
  worktrees: string[];
  className?: string;
}

// Names the worktrees a path was found in when the main checkout
// doesn't have it. Renders nothing otherwise.
export function OnlyInWorktrees({
  inPrimary,
  worktrees,
  className,
}: OnlyInWorktreesProps) {
  if (inPrimary || worktrees.length === 0) return null;
  const names = worktrees.join(", ");
  return (
    <span
      className={cn("truncate text-[11px] text-muted-foreground/70", className)}
      title={`Not in the main checkout. Found in: ${names}`}
    >
      in {names}
    </span>
  );
}
