import type { RepoEntryHolder } from "@/hooks/remote/useRepoListing";
import { cn } from "@/lib/utils";

interface OnlyInWorktreesProps {
  inPrimary: boolean;
  worktrees: readonly string[];
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
    <FoundNote
      note={`in ${names}`}
      title={`Not in the main checkout. Found in: ${names}`}
      className={className}
    />
  );
}

// Names where a path was found across the devices holding the repo,
// each with its worktrees when its main checkout doesn't have it.
export function FoundOnDevices({
  holders,
  className,
}: {
  holders: RepoEntryHolder[];
  className?: string;
}) {
  const names = holders
    .map(({ device, inPrimary, worktrees }) =>
      inPrimary ? device : `${device} (${worktrees.join(", ")})`,
    )
    .join(", ");
  return (
    <FoundNote
      note={`on ${names}`}
      title={`Not in every device's main checkout. Found on: ${names}`}
      className={className}
    />
  );
}

function FoundNote({
  note,
  title,
  className,
}: {
  note: string;
  title: string;
  className?: string;
}) {
  return (
    <span
      className={cn("truncate text-2xs text-muted-foreground/70", className)}
      title={title}
    >
      {note}
    </span>
  );
}
