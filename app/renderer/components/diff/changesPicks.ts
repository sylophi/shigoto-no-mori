import { useSyncExternalStore } from "react";
import {
  changeKey,
  sameRange,
  type ChangedFile,
  type CommitPicks,
  type FileHunks,
  type LineChange,
} from "@shared/schemas";
import { changedFilePaths } from "./changesControls";

// What the changes page has ticked. The page holds it rather than
// reading it off the index, the way GitHub Desktop does: every file
// starts ticked, one that turns up later comes in ticked, and the index
// is left alone until a commit sets it to exactly this
// (host/lib/git/commit.ts). So a file an agent staged (`git mv` does)
// doesn't decide what goes in, and a tick here doesn't hand the user's
// picks to an agent's `git commit`. Ticks are this window's own: another
// device keeps its own.
//
// By row (changeKey), the rows that aren't wholly ticked: the changes of
// theirs that go in, none for a row left out. A picked change is known
// by its place in `base`, the HEAD its file's hunks were read against
// (sameRange): an edit elsewhere in the file leaves that where it was,
// and a new HEAD makes the picks stale.
export interface Picked {
  changes: readonly LineChange[];
  base?: string;
}
export type ChangesPicks = ReadonlyMap<string, Picked>;

// How much of a row goes in: the row's checkbox.
export type Ticked = "all" | "partial" | "none";

const ALL_TICKED: ChangesPicks = new Map();
const LEFT_OUT: Picked = { changes: [] };

export function tickedOf(picks: ChangesPicks, file: ChangedFile): Ticked {
  const picked = picks.get(changeKey(file));
  if (!picked) return "all";
  return picked.changes.length === 0 ? "none" : "partial";
}

// How many rows a commit right now would take something from.
export function countIncluded(
  picks: ChangesPicks,
  files: readonly ChangedFile[],
): number {
  return files.filter((file) => tickedOf(picks, file) !== "none").length;
}

export function setFilesTicked(
  picks: ChangesPicks,
  keys: readonly string[],
  ticked: boolean,
): ChangesPicks {
  const next = new Map(picks);
  for (const key of keys) {
    if (ticked) next.delete(key);
    else next.set(key, LEFT_OUT);
  }
  return next;
}

// Of the changes a file has now, the ones that go in.
export function pickedHunks(
  picks: ChangesPicks,
  key: string,
  hunks: FileHunks,
): LineChange[] {
  const picked = picks.get(key);
  if (!picked) return [...hunks.changes];
  if (picked.base !== hunks.head) return [];
  return hunks.changes.filter((change) =>
    picked.changes.some((p) => sameRange(p, change)),
  );
}

// The file's picks as `picked`, out of the changes it has now: every
// one of them is the file ticked whole. A file with no changes left to
// read by the line (it stopped being text) keeps none rather than going
// in whole.
function withHunks(
  picks: ChangesPicks,
  key: string,
  hunks: FileHunks,
  picked: readonly LineChange[],
): ChangesPicks {
  const next = new Map(picks);
  const all = hunks.changes;
  if (all.length > 0 && picked.length === all.length) next.delete(key);
  else if (picked.length === 0) next.set(key, LEFT_OUT);
  else next.set(key, { changes: picked, base: hunks.head });
  return next;
}

export function setHunksTicked(
  picks: ChangesPicks,
  key: string,
  hunks: FileHunks,
  changes: readonly LineChange[],
  ticked: boolean,
): ChangesPicks {
  const current = pickedHunks(picks, key, hunks);
  const next = hunks.changes.filter((change) =>
    changes.some((c) => sameRange(c, change))
      ? ticked
      : current.includes(change),
  );
  return withHunks(picks, key, hunks, next);
}

// The picks still about something on screen: rows that are gone (a
// file committed, discarded or reverted in an editor) drop theirs, so
// one that turns up again comes in ticked, and the file in the pane
// drops the changes it no longer has (all of them, read against another
// HEAD).
export function prunedPicks(
  picks: ChangesPicks,
  files: readonly ChangedFile[],
  pane?: { key: string; hunks: FileHunks },
): ChangesPicks {
  const listed = new Set(files.map(changeKey));
  let next = picks;
  for (const key of picks.keys()) {
    if (!listed.has(key)) next = setFilesTicked(next, [key], true);
  }
  const picked = pane && next.get(pane.key);
  if (pane && picked && picked.changes.length > 0) {
    const kept = pickedHunks(next, pane.key, pane.hunks);
    if (kept.length !== picked.changes.length) {
      next = withHunks(next, pane.key, pane.hunks, kept);
    }
  }
  return next;
}

// After a commit: what was left out stays out. A file ticked by hunk
// went in by those hunks, so what is left of it starts over, ticked.
export function afterCommit(picks: ChangesPicks): ChangesPicks {
  return new Map(
    [...picks].filter(([, picked]) => picked.changes.length === 0),
  );
}

// What a commit sends for the rows on screen.
export function commitPicksOf(
  picks: ChangesPicks,
  files: readonly ChangedFile[],
): CommitPicks {
  const paths: string[] = [];
  const hunks: CommitPicks["hunks"] = [];
  for (const file of files) {
    const picked = picks.get(changeKey(file));
    if (!picked) paths.push(...changedFilePaths(file));
    else if (picked.base && picked.changes.length > 0) {
      hunks.push({
        path: file.path,
        base: picked.base,
        changes: [...picked.changes],
      });
    }
  }
  return { paths, hunks };
}

// Held for the session per worktree, so leaving the page and coming
// back keeps them. A reload starts over at everything.
const held = new Map<string, ChangesPicks>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const keyOf = (projectId: string, worktreeId: string) =>
  `${projectId}.${worktreeId}`;

export function useChangesPicks(
  projectId: string,
  worktreeId: string,
): ChangesPicks {
  const key = keyOf(projectId, worktreeId);
  return useSyncExternalStore(subscribe, () => held.get(key) ?? ALL_TICKED);
}

// From what is held rather than what a render saw, so two ticks before
// a re-render both land.
export function updatePicks(
  projectId: string,
  worktreeId: string,
  change: (current: ChangesPicks) => ChangesPicks,
): void {
  const key = keyOf(projectId, worktreeId);
  const current = held.get(key) ?? ALL_TICKED;
  const next = change(current);
  if (next === current) return;
  if (next.size === 0) held.delete(key);
  else held.set(key, next);
  for (const listener of listeners) listener();
}
