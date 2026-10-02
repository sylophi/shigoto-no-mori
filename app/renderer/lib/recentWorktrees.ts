import { readStoredJson, writeStored } from "@/lib/localStorage";
// When each worktree was last opened in this window, across every
// project and device, for the worktree palette's order: where you were
// last floats to the top. Keyed by the sidebar's row key (worktreeRowKey,
// device-qualified for a peer's, since the same repo on two machines
// can carry the same worktree id), and trimmed to the newest few so the
// record can't grow without bound.
const VISITS_KEY = "recentWorktree.visits";
const MAX_VISITS = 100;

// Anything but a finite timestamp (a hand-edited or corrupt record) is
// dropped, so the palette's sort always compares numbers.
export function readWorktreeVisits(): Record<string, number> {
  const stored = readStoredJson<Record<string, unknown>>(VISITS_KEY, {});
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

export function recordWorktreeVisit(rowKey: string): void {
  const visits = readWorktreeVisits();
  visits[rowKey] = Date.now();
  const newest = Object.entries(visits)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, MAX_VISITS);
  writeStored(VISITS_KEY, JSON.stringify(Object.fromEntries(newest)));
}
