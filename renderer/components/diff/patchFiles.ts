// How a changed file is described, in one place: the identity the diff
// scroll area and the file rail agree on, the counts and marker each
// row shows, and the two ways a rail's rows are built (from a patch on
// a read-only diff, from git status on the changes page).
import type { ChangeTypes, FileDiffMetadata } from "@pierre/diffs";
import type { ChangeCounts, ChangedFile, ChangeKind } from "@shared/schemas";

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
  // Row identity: what the filter and the React key run on, what a
  // click hands back, and what marks the row as the current one.
  key: string;
  path: string;
  prevPath: string | null;
  mark: ChangeMark;
  stats: ChangeCounts | null;
  // The status row behind this file, absent on a read-only diff.
  row: ChangedFile | null;
}

// A read-only patch is its own table of contents: one row per file it
// carries, in the order the scroll area has them. The key is the
// patch's own identity for a file, which is what the scroll spy and the
// jump both speak.
export function patchEntries(files: readonly FileDiffMetadata[]): IndexEntry[] {
  return files.map((file) => ({
    key: fileKey(file),
    path: file.name,
    prevPath: file.prevName ?? null,
    mark: PATCH_MARKS[file.type],
    stats: fileStats(file),
    row: null,
  }));
}

// The changes page lists what `git status` reports -- the list the
// commit button acts on -- and every row is drawn from that one read:
// the marker from the change kind, the counts from git's own numstat.
// Nothing is joined against a patch here, because there is no patch to
// join against: the pane fetches the diff of whichever row is picked.
export function changeEntries(files: readonly ChangedFile[]): IndexEntry[] {
  // Order is the list's own -- listChangedFiles sorts by path -- so the
  // rail, the pane's first pick and the commit all agree on it.
  return files.map(
    (row): IndexEntry => ({
      key: row.path,
      path: row.path,
      prevPath: row.prevPath ?? null,
      mark: STATUS_MARKS[row.kind],
      stats:
        row.additions === undefined || row.deletions === undefined
          ? null
          : { additions: row.additions, deletions: row.deletions },
      row,
    }),
  );
}
