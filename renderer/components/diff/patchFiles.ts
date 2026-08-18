// Small readers over pierre's parsed patch shape, shared by the diff
// scroll area and the file index rail so both describe a file the same
// way.
import type { ChangeTypes, FileDiffMetadata } from "@pierre/diffs";

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
export const CHANGE_MARKS: Record<
  ChangeTypes,
  { mark: string; label: string; className: string }
> = {
  new: { mark: "A", label: "Added", className: "text-emerald-500" },
  deleted: { mark: "D", label: "Deleted", className: "text-rose-500" },
  "rename-pure": { mark: "R", label: "Renamed", className: "text-sky-500" },
  "rename-changed": { mark: "R", label: "Renamed", className: "text-sky-500" },
  change: { mark: "M", label: "Modified", className: "text-muted-foreground" },
};
