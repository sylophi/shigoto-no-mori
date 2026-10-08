import {
  canRewriteCommits,
  type CommitSummary,
  type Worktree,
} from "@shared/schemas";

// What may be done to the commit at `index` of a newest-first list:
// amend it (HEAD only), undo back to it, reword it, or squash it into
// the row below. Undoing HEAD resets to the row below it. Undoing to an
// older row resets to that row and takes every newer commit with it.
// All only while the affected commits exist nowhere but here
// (canRewriteCommits).
export interface CommitRewrite {
  canAmend: boolean;
  // The commit the list showed on top, which a reword or squash pins
  // HEAD to the way an undo does. Null when the move isn't allowed.
  reword: { head: string } | null;
  squash: { head: string } | null;
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
  const pinned = head === undefined ? null : { head };
  return {
    canAmend: index === 0 && local,
    reword: canRewriteCommits(worktree, index + 1) ? pinned : null,
    squash:
      commits[index + 1] !== undefined && canRewriteCommits(worktree, index + 2)
        ? pinned
        : null,
    undo:
      target !== undefined && head !== undefined && local
        ? { target, count, head }
        : null,
  };
}
