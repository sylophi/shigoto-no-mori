// Stacked pull requests, read off the project-wide branch -> PR map.
// A PR is stacked on another when its base is that PR's head, so the
// map alone says which PRs form a stack, without gh's stack extension
// or GitHub's stack object. GitHub's own stacks (`gh stack`) are chains
// like this too, so they are found the same way.
//
// A stack is linear: the chain from the trunk up. Where a PR has two
// PRs based on it, each of those heads its own stack over the shared
// ancestry, and walking up stops at the fork.
import type { PullRequest } from "./schemas/pullRequest";
import type { Worktree } from "./schemas/worktree";

export interface PullRequestStackEntry {
  // The PR's head branch, the key it sits under in the map.
  branch: string;
  pr: PullRequest;
}

export interface PullRequestStack {
  // Bottom first: entries[0] is the PR that merges into `base`, and
  // each later PR merges into the one before it.
  entries: PullRequestStackEntry[];
  // The branch the whole stack lands on.
  base: string;
  // Where the asked-for branch sits in `entries`.
  index: number;
}

// Cycles are impossible on GitHub, but the map is a snapshot of
// possibly-stale rows, so the walks are bounded rather than trusted.
const MAX_DEPTH = 64;

// The stack `branch` is part of, or null when its PR stands alone.
// `trunk` (the project's primary branch) is never a stack member: a
// long-lived "main -> production" PR would otherwise make every PR
// based on main look stacked on it. Merged and closed PRs stay in the
// chain: a stack whose bottom has landed, with the next PR still based
// on the landed branch, is still that stack.
export function pullRequestStackFor(
  prs: Record<string, PullRequest>,
  branch: string,
  trunk?: string,
): PullRequestStack | null {
  const own = prs[branch];
  if (!own || branch === trunk) return null;
  const visited = new Set<string>([branch]);
  const below: PullRequestStackEntry[] = [];
  let cursor = own;
  while (below.length < MAX_DEPTH) {
    const parentBranch = cursor.baseRefName;
    const parent = prs[parentBranch];
    if (!parent || parentBranch === trunk || visited.has(parentBranch)) break;
    visited.add(parentBranch);
    below.push({ branch: parentBranch, pr: parent });
    cursor = parent;
  }
  const above: PullRequestStackEntry[] = [];
  let top = branch;
  while (above.length < MAX_DEPTH) {
    const children = childrenOf(prs, top).filter((c) => !visited.has(c.branch));
    if (children.length !== 1) break;
    const child = children[0]!;
    visited.add(child.branch);
    above.push(child);
    top = child.branch;
  }
  if (below.length === 0 && above.length === 0) return null;
  const entries = [...below.toReversed(), { branch, pr: own }, ...above];
  return { entries, base: entries[0]!.pr.baseRefName, index: below.length };
}

function childrenOf(
  prs: Record<string, PullRequest>,
  branch: string,
): PullRequestStackEntry[] {
  const children: PullRequestStackEntry[] = [];
  for (const [head, pr] of Object.entries(prs)) {
    if (pr.baseRefName === branch && head !== branch)
      children.push({ branch: head, pr });
  }
  return children;
}

// The PRs a stack merge from `entry` lands: every PR from the bottom
// up to and including it that hasn't merged yet. A closed PR in that
// range breaks the stack (its changes would ride up with the PR above
// it), so the set is null then, and the UI says why.
export function stackMergeSet(
  stack: PullRequestStack,
  index: number,
): PullRequestStackEntry[] | null {
  const range = stack.entries.slice(0, index + 1);
  if (range.some((entry) => entry.pr.state === "CLOSED")) return null;
  return range.filter((entry) => entry.pr.state === "OPEN");
}

// One repo's rows with every stack's members brought together, in
// stack order with the top first (the way the worktree page lists a
// stack), at the place the first member held. Rows outside a stack
// keep their order. Two rows on one branch (a peer's copy beside the
// local one) stay adjacent in their own order.
export function groupByStack<T>(
  items: readonly T[],
  branchOf: (item: T) => string,
  prs: Record<string, PullRequest> | undefined,
  trunk?: string,
): T[] {
  if (!prs) return [...items];
  // By position, not identity: two rows may be equal values.
  const placed = new Set<number>();
  const out: T[] = [];
  items.forEach((item, index) => {
    if (placed.has(index)) return;
    const stack = pullRequestStackFor(prs, branchOf(item), trunk);
    if (!stack) {
      out.push(item);
      return;
    }
    for (const entry of stack.entries.toReversed()) {
      items.forEach((member, at) => {
        if (placed.has(at) || branchOf(member) !== entry.branch) return;
        placed.add(at);
        out.push(member);
      });
    }
  });
  return out;
}

// Where a branch's PR sits in its stack, for the sidebar's pill: null
// for a PR that stands alone.
export function pullRequestStackPosition(
  prs: Record<string, PullRequest> | undefined,
  branch: string,
  trunk?: string,
): { index: number; size: number } | null {
  if (!prs) return null;
  const stack = pullRequestStackFor(prs, branch, trunk);
  return stack ? { index: stack.index, size: stack.entries.length } : null;
}

// The project's primary branch, off the listing it already carries:
// every non-primary worktree names the ref it syncs from (primaryRef,
// "main" or "origin/main"), and the primary checkout's own branch
// says which spelling that is. The checkout alone won't do: it can
// have a feature branch out, and that branch's PR would then read as
// the trunk instead of as a stack member.
export function trunkOf(
  worktrees: readonly Worktree[] | undefined,
): string | undefined {
  if (!worktrees) return undefined;
  const primary = worktrees.find((worktree) => worktree.isPrimary);
  const ref = worktrees.find((worktree) => worktree.primaryRef)?.primaryRef;
  if (!ref) return primary?.branch;
  if (
    primary &&
    (ref === primary.branch || ref.endsWith(`/${primary.branch}`))
  ) {
    return primary.branch;
  }
  // A remote-tracking ref with no local checkout to confirm the split:
  // drop the remote segment. Only a slash-named default branch with no
  // remote at all reads wrong here, and then only while the primary
  // checkout is on another branch.
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}
