import { Loader2 } from "lucide-react";
import { useIsFetching } from "@tanstack/react-query";
import { useDelayedFlag } from "@/hooks/ui/useDelayedFlag";
import { useProjectGitFetching } from "@/hooks/git/useProjectGitFetching";
import type { Worktree } from "@shared/schemas";

// Sub-second refetches would otherwise flash on/off too fast to read.
const REFRESH_DELAY_MS = 250;

export function WorktreeActivityIndicator({
  worktree,
}: {
  worktree: Worktree;
}) {
  const label = useActivityLabel(worktree);
  const visible = useDelayedFlag(label !== null, REFRESH_DELAY_MS);
  if (!visible || label === null) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 self-center text-xs text-muted-foreground/70 italic">
      <Loader2 aria-hidden className="size-3 animate-spin" />
      {label}
    </span>
  );
}

function useActivityLabel(worktree: Worktree): string | null {
  const branchesFetching = useIsFetching({
    queryKey: ["branches", worktree.projectId],
  });
  const worktreesFetching = useIsFetching({
    queryKey: ["worktrees", worktree.projectId],
  });
  const gitFetching = useProjectGitFetching(worktree.projectId);

  // Priority order matches the order users care about: the project-
  // wide fetch is the most "happening", then per-worktree state, then
  // branches. PR refreshes have their own indicator in the section
  // header. When more than one is in flight, drop the specificity and
  // just say "Refreshing…".
  const active: string[] = [];
  if (gitFetching) active.push("Fetching refs…");
  if (worktreesFetching > 0) active.push("Refreshing worktree state…");
  if (branchesFetching > 0) active.push("Refreshing branches…");

  if (active.length === 0) return null;
  if (active.length === 1) return active[0] ?? null;
  return "Refreshing…";
}
