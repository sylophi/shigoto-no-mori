import type { CommitSummary, Worktree } from "@shared/schemas";
import { useBranchHistory } from "@/hooks/git/useBranchCommits";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useWorktreeOperation } from "@/hooks/worktrees/useGitHistory";
import {
  commitRewriteAt,
  NO_REWRITE,
  type CommitRewrite,
} from "@/lib/commitRewrite";

// What each of `commits` (newest first, from HEAD) allows, with the
// branch's merges from its history read. Nothing while a merge, rebase
// or squash waits on the user: git would refuse, or worse, go along.
// Nothing either on a peer that takes no commands from here.
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
  const { canCommand } = useCommandAccess();
  const merges = new Map(history?.merges.map((m) => [m.hash, m.firstParent]));
  return (index) =>
    canCommand && operation?.operation == null
      ? commitRewriteAt(worktree, commits, index, merges)
      : NO_REWRITE;
}
