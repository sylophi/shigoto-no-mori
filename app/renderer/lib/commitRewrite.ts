import {
  canRewriteCommits,
  type CommitSummary,
  type Worktree,
} from "@shared/schemas";

// What may be done to the commit at `index` of a newest-first list:
// amend it (HEAD only), or undo back to it. Undoing HEAD resets to the
// row below it. Undoing to an older row resets to that row and takes
// every newer commit with it. Both only while the affected commits
// exist nowhere but here (canRewriteCommits).
export interface CommitRewrite {
  canAmend: boolean;
  // `head` is the commit the list showed on top. The reset is refused if
  // HEAD has moved since (a commit made in a terminal meanwhile), so an
  // undo never takes more than the rows it named.
  undo: { target: string; count: number; head: string } | null;
}

export function commitRewriteAt(
  worktree: Worktree,
  commits: readonly CommitSummary[],
  index: number,
): CommitRewrite {
  const count = index === 0 ? 1 : index;
  const target = index === 0 ? commits[1]?.hash : commits[index]?.hash;
  const head = commits[0]?.hash;
  const local = canRewriteCommits(worktree, count);
  return {
    canAmend: index === 0 && local,
    undo:
      target !== undefined && head !== undefined && local
        ? { target, count, head }
        : null,
  };
}
