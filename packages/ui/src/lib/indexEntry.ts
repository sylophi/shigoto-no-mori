// One file in a diff's file rail, as the app's lib/patchFiles.ts builds
// it from a patch or from git status.
import type { ChangeCounts, ChangedFile } from "@shigomori/contracts/schemas";

// One-letter change marker in git's own vocabulary (A/D/R/M).
export interface ChangeMark {
  mark: string;
  label: string;
  className: string;
}

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
