import { only } from "@shared/util/only";
import { useIsFetching } from "@tanstack/react-query";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useDelayedFlag } from "@/hooks/ui/useDelayedFlag";
import { useProjectGitFetching } from "@/hooks/git/useProjectGitFetching";
import type { Worktree } from "@shared/schemas";
import { WorktreeActivityIndicatorView } from "./WorktreeActivityIndicatorView";

export function WorktreeActivityIndicator({
  worktree,
}: {
  worktree: Worktree;
}) {
  const label = useActivityLabel(worktree);
  const visible = useDelayedFlag(label !== null);
  return <WorktreeActivityIndicatorView label={visible ? label : null} />;
}

function useActivityLabel(worktree: Worktree): string | null {
  const { keys } = useHostScope();
  const branchesFetching = useIsFetching({
    queryKey: keys.branches(worktree.projectId),
  });
  const worktreesFetching = useIsFetching({
    queryKey: keys.worktrees(worktree.projectId),
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
  return only(active) ?? "Refreshing…";
}
