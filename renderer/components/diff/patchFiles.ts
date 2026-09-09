// How a changed file is described, in one place: the identity the diff
// scroll area and the file rail agree on, the counts and marker each
// row shows, and the two ways a rail's rows are built (from a patch on
// a read-only diff, from git status on the changes page).
import type { ChangeTypes, FileDiffMetadata } from "@pierre/diffs";
import type { ChangedFile, ChangeKind } from "@shared/schemas";

// Stable identity for one file inside one patch. `name` alone collides
// on a rename pair (the old path can still appear as another entry), so
// the previous name is part of the key. That is the same composition
// the FileDiff list already used for its React key.
export function fileKey(file: FileDiffMetadata): string {
  return `${file.prevName ?? ""} ${file.name}`;
}

// FileDiffMetadata carries no aggregate counts, so sum the hunks the way
// pierre's own file header does (createFileHeaderElement). Cheap: hunk
// counts are precomputed by the parser, this is a walk over ~tens of
// entries per file.
export function fileStats(file: FileDiffMetadata): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

// One-letter change marker in git's own vocabulary (A/D/R/M). A status
// column reads faster than five icons and costs one character of rail
// width. Colors stay inside the four families doubutsu remaps.
export interface ChangeMark {
  mark: string;
  label: string;
  className: string;
}

const ADDED: ChangeMark = {
  mark: "A",
  label: "Added",
  className: "text-emerald-500",
};
const DELETED: ChangeMark = {
  mark: "D",
  label: "Deleted",
  className: "text-rose-500",
};
const RENAMED: ChangeMark = {
  mark: "R",
  label: "Renamed",
  className: "text-sky-500",
};
const MODIFIED: ChangeMark = {
  mark: "M",
  label: "Modified",
  className: "text-muted-foreground",
};

// Two vocabularies land on the same four marks: pierre's, for a patch
// read on its own, and git status's, for the changes page.
const PATCH_MARKS: Record<ChangeTypes, ChangeMark> = {
  new: ADDED,
  deleted: DELETED,
  "rename-pure": RENAMED,
  "rename-changed": RENAMED,
  change: MODIFIED,
};

const STATUS_MARKS: Record<ChangeKind, ChangeMark> = {
  added: ADDED,
  deleted: DELETED,
  renamed: RENAMED,
  modified: MODIFIED,
};

// One row of the file rail. The rail draws these and nothing else, so
// where the rows come from is the caller's decision rather than a shape
// the rail has to know about.
export interface IndexEntry {
  // Row identity, and what the filter and the React key run on.
  key: string;
  path: string;
  prevPath: string | null;
  mark: ChangeMark;
  // The patch entry this row scrolls to, when the patch has one. Null
  // rows still tick and discard; there is just nothing to jump to.
  target: string | null;
  stats: { additions: number; deletions: number } | null;
  // The status row behind this file, absent on a read-only diff.
  row: ChangedFile | null;
}

function entryOf(file: FileDiffMetadata): IndexEntry {
  return {
    key: fileKey(file),
    path: file.name,
    prevPath: file.prevName ?? null,
    mark: PATCH_MARKS[file.type],
    target: fileKey(file),
    stats: fileStats(file),
    row: null,
  };
}

// A read-only patch is its own table of contents: one row per file it
// carries, in the order the scroll area has them.
export function patchEntries(files: readonly FileDiffMetadata[]): IndexEntry[] {
  return files.map(entryOf);
}

// The changes page lists what `git status` reports, which is the list
// the commit button acts on. The patch is read only for what it can add
// to a row -- the counts and somewhere to scroll to.
//
// The two disagree more often than it looks. `git diff HEAD` compares
// HEAD with the working tree and pairs a deletion with an addition as
// one rename; status compares HEAD, index and working tree separately,
// so the same pair stays two rows until both halves are staged. Listing
// from the patch there drops a file the commit would still take, which
// is the one thing this list must never do.
export function changeEntries(
  files: readonly ChangedFile[],
  patch: readonly FileDiffMetadata[],
): IndexEntry[] {
  const byName = new Map(patch.map((file) => [file.name, file]));
  // A file git folded into a rename is reachable under the name it had:
  // the deleted half of the pair scrolls to the entry that swallowed it.
  const byPrevName = new Map(
    patch.flatMap((file) => (file.prevName ? [[file.prevName, file]] : [])),
  );
  return files
    .map((row): IndexEntry => {
      const own = byName.get(row.path);
      const match = own ?? byPrevName.get(row.path);
      return {
        key: row.path,
        path: row.path,
        prevPath: row.prevPath ?? null,
        mark: STATUS_MARKS[row.kind],
        target: match ? fileKey(match) : null,
        // Counts belong to the patch entry itself, so the half that was
        // folded into a rename doesn't restate the pair's numbers.
        stats: own ? fileStats(own) : null,
        row,
      };
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
