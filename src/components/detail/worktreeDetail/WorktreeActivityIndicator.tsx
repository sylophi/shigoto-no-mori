import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useIsFetching } from "@tanstack/react-query";
import { useProjectGitFetching } from "@/hooks/useProjectGitFetching";
import { worktreePullRequestKey } from "@/hooks/useWorktreePullRequest";
import type { Worktree } from "@shared/schemas";

// Sub-second refetches would otherwise flash on/off too fast to read.
// We delay showing the label until 250ms after work begins; if the
// work finishes inside that window the user never sees a flicker.
const MIN_VISIBLE_DELAY_MS = 250;

export function WorktreeActivityIndicator({
  worktree,
}: {
  worktree: Worktree;
}) {
  const label = useActivityLabel(worktree);
  const visible = useDelayedLabel(label);
  if (!visible) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 self-center text-xs text-muted-foreground/70 italic">
      <Loader2 aria-hidden className="size-3 animate-spin" />
      {visible}
    </span>
  );
}

function useActivityLabel(worktree: Worktree): string | null {
  const prFetching = useIsFetching({
    queryKey: worktreePullRequestKey(worktree.projectId, worktree.branch),
  });
  const branchesFetching = useIsFetching({
    queryKey: ["branches", worktree.projectId],
  });
  const mergeConfigFetching = useIsFetching({
    queryKey: ["githubCli", "repoMergeConfig", worktree.projectId],
  });
  const worktreesFetching = useIsFetching({
    queryKey: ["worktrees", worktree.projectId],
  });
  const gitFetching = useProjectGitFetching(worktree.projectId);

  // Priority order matches the order users care about: the project-
  // wide fetch is the most "happening", then per-worktree state, then
  // the PR, then secondary metadata. When more than one is in flight,
  // drop the specificity and just say "Refreshing…".
  const active: string[] = [];
  if (gitFetching) active.push("Fetching refs…");
  if (worktreesFetching > 0) active.push("Refreshing worktree state…");
  if (prFetching > 0) active.push("Refreshing pull request…");
  if (branchesFetching > 0) active.push("Refreshing branches…");
  if (mergeConfigFetching > 0) active.push("Fetching repo settings…");

  if (active.length === 0) return null;
  if (active.length === 1) return active[0] ?? null;
  return "Refreshing…";
}

function useDelayedLabel(label: string | null): string | null {
  const [visible, setVisible] = useState<string | null>(null);
  useEffect(() => {
    if (label === null) {
      setVisible(null);
      return;
    }
    if (visible !== null) {
      // Already showing -- swap labels immediately so the eye sees the
      // newest state without flicker.
      setVisible(label);
      return;
    }
    const id = window.setTimeout(() => setVisible(label), MIN_VISIBLE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [label, visible]);
  return visible;
}
