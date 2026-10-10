import { assertNever } from "@shigomori/ui/lib/utils.ts";
import {
  type Worktree,
  type WorktreeSortMode,
  worktreeLastActivityAt,
} from "@shigomori/contracts/schemas";

// Orders an open project's worktrees for the tree, every device's
// together: a worktree on another machine sorts among this one's, not
// after them. The primary checkouts lead whatever the mode, the way
// the CLI lists them, in the order given: this machine's first. Other
// ties fall to the name, then to the order given.
export function sortWorktrees<T>(
  items: readonly T[],
  mode: WorktreeSortMode,
  worktreeOf: (item: T) => Worktree,
): T[] {
  const key = sortKey(mode);
  return items.toSorted((a, b) => {
    const wa = worktreeOf(a);
    const wb = worktreeOf(b);
    if (wa.isPrimary || wb.isPrimary) {
      return Number(wb.isPrimary) - Number(wa.isPrimary);
    }
    const diff = key(wb) - key(wa);
    return diff !== 0 ? diff : byName(wa, wb);
  });
}

// Newest first. The name order has no key of its own and falls
// straight through to the tie-break.
function sortKey(mode: WorktreeSortMode): (worktree: Worktree) => number {
  switch (mode) {
    case "name":
      return () => 0;
    case "recent":
      return worktreeLastActivityAt;
    case "created":
      // Unknown (a peer on a build older than the field) sorts last.
      return (worktree) => worktree.createdAt ?? 0;
    default:
      return assertNever(mode);
  }
}

// One collator for every comparison: localeCompare with options
// builds a fresh one per call.
const collator = new Intl.Collator(undefined, { numeric: true });
const byName = (a: Worktree, b: Worktree) => collator.compare(a.name, b.name);
