import { Loader2 } from "lucide-react";
import { useIsFetching } from "@tanstack/react-query";
import { useDelayedFlag } from "@/hooks/ui/useDelayedFlag";
import { useHostScope } from "@/hooks/remote/useHostScope";
import type { Worktree } from "@shared/schemas";

// Sub-second refetches would otherwise flash on/off too fast to read.
const REFRESH_INDICATOR_DELAY_MS = 250;

export function PullRequestRefreshIndicator({
  worktree,
}: {
  worktree: Worktree;
}) {
  const { keys } = useHostScope();
  const fetching =
    useIsFetching({
      queryKey: keys.worktreePullRequest(worktree.projectId, worktree.branch),
    }) > 0;
  const visible = useDelayedFlag(fetching, REFRESH_INDICATOR_DELAY_MS);
  if (!visible) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground/70 italic">
      <Loader2 aria-hidden className="size-3 animate-spin" />
      Refreshing…
    </span>
  );
}
