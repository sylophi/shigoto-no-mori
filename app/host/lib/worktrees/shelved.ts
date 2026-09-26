// Shelf state for worktrees: a flat set of worktree ids that the user
// has chosen to hide from the sidebar's main list. Purely a UI hint.
// The worktree itself is untouched on disk, and nothing per-worktree
// (scripts, ports, processes) is stopped. Stored in the global
// registry.json alongside the project list, since rebuilding a shelf by
// hand means remembering which of dozens of worktrees were hidden. Not
// in the per-project shigomori config: "what's currently in focus" is a
// per-user, per-machine thing rather than a property of the repo. The
// CLI mutates this key too (shelve, unshelve, and the drop on rm).
//
// A shelved worktree that gets worked in comes back off the shelf on
// its own. The worktree list already probes every row's HEAD and
// uncommitted changes, so the check costs no git of its own: the first
// listing that sees a worktree shelved records a snapshot of it, and a
// later listing that finds it moved past that snapshot unshelves it.
// Commits show up within the git watcher's debounce (it relists on
// every ref move), edits on the next focus or background refresh.
import { z } from "zod";
import { errorMessageOf } from "@shared/errors";
import {
  SHELF_SNAPSHOTS_KEY,
  SHELVED_KEY,
  registryStore,
} from "../config/store";
import { makeRegistryIdSet } from "./registryIdSet";

export const shelvedMarks = makeRegistryIdSet(SHELVED_KEY);

export const isShelved = shelvedMarks.has;
export const readShelvedSet = shelvedMarks.readSet;

// Any shelf change retires the worktree's snapshot, the same rule as
// the CLI's setShelved.
export function setShelved(worktreeId: string, shelved: boolean): void {
  shelvedMarks.set(worktreeId, shelved);
  shelfSnapshots.drop(worktreeId);
}

export function dropShelved(worktreeId: string): void {
  setShelved(worktreeId, false);
}

// A shelved worktree as the first listing after the shelve saw it.
// `head` is null when the log came back empty: no commits yet, or a
// failed read.
const ShelfSnapshotSchema = z.object({
  at: z.number(),
  head: z.string().nullable(),
  changed: z.number(),
});
export type ShelfSnapshot = z.infer<typeof ShelfSnapshotSchema>;

type SnapshotMap = Record<string, unknown>;

// Keyed by worktree id like the marks, so marks.ts retires them the
// same way. The CLI can't compute a snapshot, so it clears one on every
// shelve and unshelve instead, and the next listing takes a fresh one.
// An entry that doesn't parse reads as absent and is replaced the same
// way.
//
// A listing reads the snapshots before its probes and acts on them
// after, so both of its writes check the entry again under the lock:
// a shelve or unshelve in between wins over the listing's stale view.
export const shelfSnapshots = {
  read(): Record<string, ShelfSnapshot> {
    const map = registryStore.readHint<SnapshotMap>(SHELF_SNAPSHOTS_KEY, {});
    const snapshots: Record<string, ShelfSnapshot> = {};
    for (const [id, raw] of Object.entries(map)) {
      const parsed = ShelfSnapshotSchema.safeParse(raw);
      if (parsed.success) snapshots[id] = parsed.data;
    }
    return snapshots;
  },
  // Records a snapshot unless one was taken since the listing read.
  seed(worktreeId: string, snapshot: ShelfSnapshot): void {
    registryStore.updateKey<SnapshotMap>(SHELF_SNAPSHOTS_KEY, {}, (map) => {
      if (worktreeId in map) return undefined;
      map[worktreeId] = snapshot;
      return map;
    });
  },
  // Removes the snapshot the listing compared against, and says whether
  // it was still the one on file.
  retire(worktreeId: string, snapshot: ShelfSnapshot): boolean {
    let current = false;
    registryStore.updateKey<SnapshotMap>(SHELF_SNAPSHOTS_KEY, {}, (map) => {
      const stored = ShelfSnapshotSchema.safeParse(map[worktreeId]);
      if (!stored.success || stored.data.at !== snapshot.at) return undefined;
      current = true;
      delete map[worktreeId];
      return map;
    });
    return current;
  },
  drop(worktreeId: string): void {
    registryStore.updateKey<SnapshotMap>(SHELF_SNAPSHOTS_KEY, {}, (map) => {
      if (!(worktreeId in map)) return undefined;
      delete map[worktreeId];
      return map;
    });
  },
  // Not carried to the new id: a relocate or a data-dir move can copy
  // the files, which gives every one of them a fresh mtime. The next
  // listing takes a new snapshot instead.
  move(from: string): void {
    shelfSnapshots.drop(from);
  },
};

// What one listing saw of a shelved worktree.
interface ShelfObservation {
  // When the row's probes started, epoch ms: a snapshot taken from them
  // covers every change older than this.
  at: number;
  // The newest commit's abbreviated hash, null when there is none (or
  // the log failed).
  head: string | null;
  // Changed paths, null when the status failed and there is nothing to
  // compare.
  changed: number | null;
  // Newest mtime among the changed paths.
  lastChangeAt?: number;
  // An auto-pull worktree with nothing unpushed: the app fast-forwards
  // it on its own, so a HEAD move there is the pull and not the user.
  // A commit made here still shows as unpushed until it is pushed.
  followsUpstream: boolean;
}

// Git lengthens abbreviated hashes as a repository grows, so the same
// commit can come back one character longer than it was recorded. A
// head the snapshot couldn't read compares as unknown: a first commit
// still shows in the changed count.
function sameCommit(seen: string, recorded: string | null): boolean {
  if (recorded === null) return true;
  return seen.startsWith(recorded) || recorded.startsWith(seen);
}

// Whether a worktree marked shelved stays shelved after this sighting,
// recording its snapshot when it has none and unshelving it when it has
// been worked in since. Failing to write either leaves it shelved: the
// next listing tries again.
//
// The mtime check only sees the first paths getWorkingTreeChanges
// stats, so a new edit to one path in a very dirty tree can slip past
// it. The count still catches any path that becomes (or stops being)
// changed.
export function settleShelf(
  worktreeId: string,
  snapshot: ShelfSnapshot | undefined,
  seen: ShelfObservation,
): boolean {
  const { at, head, changed } = seen;
  if (changed === null) return true;
  try {
    if (snapshot === undefined) {
      shelfSnapshots.seed(worktreeId, { at, head, changed });
      return true;
    }
    const worked =
      (head !== null &&
        !sameCommit(head, snapshot.head) &&
        !seen.followsUpstream) ||
      changed !== snapshot.changed ||
      (seen.lastChangeAt ?? 0) > snapshot.at;
    if (!worked || !shelfSnapshots.retire(worktreeId, snapshot)) return true;
    shelvedMarks.set(worktreeId, false);
    return false;
  } catch (error) {
    console.warn(
      `[shelf] could not update the shelf: ${errorMessageOf(error)}`,
    );
    return true;
  }
}
