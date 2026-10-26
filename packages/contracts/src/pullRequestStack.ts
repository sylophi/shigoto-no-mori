// A stack is GitHub's: a PR based on another PR's head is only stacked
// on it when GitHub holds both in the same stack. Within it, the bases
// give the order. A stack is linear: where a PR has two PRs based on it,
// walking up stops at the fork.
import { only } from "./util/only.ts";
import type { PullRequest } from "./schemas/pullRequest.ts";
import type { Worktree } from "./schemas/worktree.ts";

export interface PullRequestStackEntry {
  branch: string;
  pr: PullRequest;
}

export interface PullRequestStack {
  // Bottom first.
  entries: PullRequestStackEntry[];
  base: string;
  index: number;
}

// The map may be stale, so the walks are bounded rather than trusted.
// The engine's Landing.ts walks the same stacks under its own
// MAX_STACK_DEPTH: change both.
const MAX_DEPTH = 64;

// `trunk` is never a member. Merged and closed PRs stay in the chain.
export function pullRequestStackFor(
  prs: Record<string, PullRequest>,
  branch: string,
  trunk?: string,
): PullRequestStack | null {
  const own = prs[branch];
  if (own?.stack === undefined || branch === trunk) return null;
  const visited = new Set<string>([branch]);
  const below: PullRequestStackEntry[] = [];
  let cursor = own;
  while (below.length < MAX_DEPTH) {
    const parentBranch = cursor.baseRefName;
    const parent = prs[parentBranch];
    if (
      parent?.stack !== own.stack ||
      parentBranch === trunk ||
      visited.has(parentBranch)
    )
      break;
    visited.add(parentBranch);
    below.push({ branch: parentBranch, pr: parent });
    cursor = parent;
  }
  const above: PullRequestStackEntry[] = [];
  let top = branch;
  while (above.length < MAX_DEPTH) {
    const child = only(
      childrenOf(prs, top).filter(
        (c) => c.pr.stack === own.stack && !visited.has(c.branch),
      ),
    );
    if (child === undefined) break;
    visited.add(child.branch);
    above.push(child);
    top = child.branch;
  }
  if (below.length === 0 && above.length === 0) return null;
  const entries = [...below.toReversed(), { branch, pr: own }, ...above];
  const base = (entries[0]?.pr ?? own).baseRefName;
  return { entries, base, index: below.length };
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

// Null when a closed PR in range breaks the stack: its changes would
// ride up with the PR above it.
export function stackMergeSet(
  stack: PullRequestStack,
  index: number,
): PullRequestStackEntry[] | null {
  const range = stack.entries.slice(0, index + 1);
  if (range.some((entry) => entry.pr.state === "CLOSED")) return null;
  return range.filter((entry) => entry.pr.state === "OPEN");
}

// `sm land --stack` removes the worktree it runs in and the merged layers
// under it, so the target is the highest. Never the primary checkout.
export interface StackCleanup<T> {
  target: T;
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

export function stackCleanupForWorktree<
  T extends {
    id: string;
    branch: string;
    isPrimary: boolean;
    primaryBranch?: string;
  },
>(
  prs: Record<string, PullRequest>,
  rows: readonly T[],
  worktreeId: string,
): StackCleanup<T> | null {
  const own = rows.find((row) => row.id === worktreeId);
  const stack = own && pullRequestStackFor(prs, own.branch, trunkOf(rows));
  return stack ? stackCleanupFor(stack, rows) : null;
}

// `index` from the bottom.
export type StackPosition = { index: number; size: number };

export interface StackRail {
  last: boolean;
  whole: boolean;
}

export interface StackPlacement<T> {
  item: T;
  position: StackPosition | null;
  rail?: StackRail;
}

// Each stack's members together, top layer first, where the first
// member was. A stack with one layer showing gets no rail, even with a
// peer's copy beside it: a rail through one layer joins nothing.
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
    // The layers with a row, counted apart from the rows: a peer's copy
    // beside the local row is the same layer.
    const layers = new Set<number>();
    for (const [at, entry] of [...stack.entries.entries()].toReversed()) {
      items.forEach((member, memberIndex) => {
        if (placed.has(memberIndex) || branchOf(member) !== entry.branch)
          return;
        placed.add(memberIndex);
        layers.add(at);
        group.push({
          item: member,
          position: { index: at, size: stack.entries.length },
        });
      });
    }
    if (layers.size > 1) {
      const whole = layers.size === stack.entries.length;
      group.forEach((placement, at) => {
        placement.rail = { last: at === group.length - 1, whole };
      });
    }
    out.push(...group);
  });
  return out;
}

export function pullRequestStackPosition(
  prs: Record<string, PullRequest> | undefined,
  branch: string,
  trunk?: string,
): StackPosition | null {
  if (!prs) return null;
  const stack = pullRequestStackFor(prs, branch, trunk);
  return stack ? { index: stack.index, size: stack.entries.length } : null;
}

// Without Worktree.primaryBranch, the primary checkout's branch: right
// whenever that checkout is on it.
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
