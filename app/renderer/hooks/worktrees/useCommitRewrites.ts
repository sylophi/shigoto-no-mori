import type { CommitSummary, Worktree } from "@shigomori/contracts/schemas";
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useWorktreeOperation } from "@/hooks/worktrees/useGitHistory";
import {
  commitRewriteAt,
  NO_REWRITE,
  type CommitRewrite,
} from "@/lib/commitRewrite";

// What each of `commits` (newest first, from HEAD) allows, with the
// branch's merges from its history read. Nothing while a merge, rebase
// or squash waits on the user: git would refuse, or worse, go along.
export function useCommitRewrites(
  worktree: Worktree,
  commits: readonly CommitSummary[],
): (index: number) => CommitRewrite {
  const { data: history } = useBranchHistory(
    worktree.projectId,
    worktree.id,
    worktree.recentCommits[0]?.hash,
  );
  const { data: operation } = useWorktreeOperation(worktree);
  const merges = new Map(history?.merges.map((m) => [m.hash, m.firstParent]));
  return (index) =>
    operation?.operation == null
      ? commitRewriteAt(worktree, commits, index, merges)
      : NO_REWRITE;
}
