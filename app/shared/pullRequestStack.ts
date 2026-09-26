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

// What a stack cleanup removes once layers have landed: every worktree
// on a merged layer's branch, and the one to run it from. The CLI's
// `sm land --stack` on an already-merged PR removes the worktree it is
// run in and those of the merged layers under it, so the target is the
// highest of them, and the worktrees are what the button counts. The
// primary checkout is never among them (the merged-primary box lands
// it back on the trunk). Null when no merged layer has a worktree.
export interface StackCleanup<T> {
  target: T;
  // Bottom first.
  worktrees: T[];
}

export function stackCleanupFor<
  T extends { id: string; branch: string; isPrimary: boolean },
>(stack: PullRequestStack, worktrees: readonly T[]): StackCleanup<T> | null {
  const landed: T[] = [];
  for (const entry of stack.entries) {
    if (entry.pr.state !== "MERGED") continue;
    for (const worktree of worktrees) {
      if (worktree.branch === entry.branch && !worktree.isPrimary)
        landed.push(worktree);
    }
  }
  const target = landed.at(-1);
  return target ? { target, worktrees: landed } : null;
}

// Where a branch's PR sits in its stack: `index` from the bottom, of
// `size` layers.
export type StackPosition = { index: number; size: number };

// A row's place under its stack's lowest row when the two sit
// together: one of the layers built on it, drawn as a child in a tree,
// the last one closing the branch.
export type StackChild = "middle" | "last";

export interface StackPlacement<T> {
  item: T;
  position: StackPosition | null;
  child?: StackChild;
}

// One repo's rows with every stack's members brought together, bottom
// first (the sidebar draws a stack as a tree, each layer nested under
// the one it is built on), at the place the first member held, each
// carrying its position and, for the members above a group's lowest
// row, its place as a child of it. Rows outside a stack keep their
// order. Two rows on one branch (a peer's copy beside the local one)
// stay adjacent in their own order. A stack with one row showing (its
// other layers shelved, or on a device the filter hides) nests
// nothing: a child with no parent row would hang in space.
export function placeByStack<T>(
  items: readonly T[],
  branchOf: (item: T) => string,
  prs: Record<string, PullRequest> | undefined,
  trunk?: string,
): StackPlacement<T>[] {
  if (!prs) return items.map((item) => ({ item, position: null }));
  // By position, not identity: two rows may be equal values.
  const placed = new Set<number>();
  const out: StackPlacement<T>[] = [];
  items.forEach((item, index) => {
    if (placed.has(index)) return;
    const stack = pullRequestStackFor(prs, branchOf(item), trunk);
    if (!stack) {
      // Placed too: a fork point has no stack of its own, and a member
      // above it would otherwise gather it into its group again.
      placed.add(index);
      out.push({ item, position: null });
      return;
    }
    const group: StackPlacement<T>[] = [];
    stack.entries.forEach((entry, at) => {
      items.forEach((member, memberIndex) => {
        if (placed.has(memberIndex) || branchOf(member) !== entry.branch)
          return;
        placed.add(memberIndex);
        group.push({
          item: member,
          position: { index: at, size: stack.entries.length },
        });
      });
    });
    if (group.length > 1) {
      group.forEach((placement, at) => {
        if (at === 0) return;
        placement.child = at === group.length - 1 ? "last" : "middle";
      });
    }
    out.push(...group);
  });
  return out;
}

// Where a branch's PR sits in its stack, for the sidebar's pill: null
// for a PR that stands alone.
export function pullRequestStackPosition(
  prs: Record<string, PullRequest> | undefined,
  branch: string,
  trunk?: string,
): StackPosition | null {
  if (!prs) return null;
  const stack = pullRequestStackFor(prs, branch, trunk);
  return stack ? { index: stack.index, size: stack.entries.length } : null;
}

// The project's primary branch, off the listing it already carries:
// the host resolves it once per listing (Worktree.primaryBranch). A
// listing from an older host without it falls back to the primary
// checkout's branch, which is right whenever that checkout is on the
// primary branch.
export function trunkOf(
  worktrees:
    | readonly Pick<Worktree, "branch" | "isPrimary" | "primaryBranch">[]
    | undefined,
): string | undefined {
  if (!worktrees) return undefined;
  return (
    worktrees.find((worktree) => worktree.primaryBranch)?.primaryBranch ??
    worktrees.find((worktree) => worktree.isPrimary)?.branch
  );
}
