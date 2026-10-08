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
// (canRewriteCommits), and hold no merge (`merges`, each hash to its
// first parent): the rewrites replay commits one parent at a time. An
// amend keeps a merge's parents, so HEAD can be amended either way, and
// a merge on top is undone whole, back to its first parent.
export interface CommitRewrite {
  canAmend: boolean;
  // The commit the list showed on top, which a reword or squash pins
  // HEAD to the way an undo does. Null when the move isn't allowed.
  reword: { head: string } | null;
  squash: { head: string } | null;
  // `head` is the commit the list showed on top. The reset is refused if
  // HEAD has moved since (a commit made in a terminal meanwhile), so an
  // undo never takes more than the rows it named.
  // `merge` when it undoes a merge on top: the branch goes back to how
  // it was before it, rather than its changes coming back staged.
  undo: { target: string; count: number; head: string; merge: boolean } | null;
}

export function commitRewriteAt(
  worktree: Worktree,
  commits: readonly CommitSummary[],
  index: number,
  merges: ReadonlyMap<string, string>,
): CommitRewrite {
  const count = index === 0 ? 1 : index;
  const target = index === 0 ? commits[1]?.hash : commits[index]?.hash;
  const head = commits[0]?.hash;
  // The newest `n` commits can be rewritten.
  const rewritable = (n: number) =>
    canRewriteCommits(worktree, n) &&
    !commits.slice(0, n).some((c) => merges.has(c.hash));
  const pinned = head === undefined ? null : { head };
  return {
    canAmend: index === 0 && canRewriteCommits(worktree, 1),
    reword: rewritable(index + 1) ? pinned : null,
    squash:
      commits[index + 1] !== undefined && rewritable(index + 2) ? pinned : null,
    undo:
      head === undefined
        ? null
        : index === 0 && merges.has(head)
          ? canRewriteCommits(worktree, 1)
            ? { target: merges.get(head) ?? "", count: 1, head, merge: true }
            : null
          : target !== undefined && rewritable(count)
            ? { target, count, head, merge: false }
            : null,
  };
}

// What a commit off HEAD's line allows: a search's results and the
// history before the branch. Nothing that rewrites from it.
export const NO_REWRITE: CommitRewrite = {
  canAmend: false,
  undo: null,
  reword: null,
  squash: null,
};
