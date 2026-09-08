import type { ChangedFile } from "@shared/schemas";

// What turns the read-only diff view into the changes page: the status
// rows behind each file's checkbox, and the actions the rail and the
// file headers fire. The status list is the sole authority on paths --
// the patch is only what gets drawn -- so every action names files by
// their status row, looked up under the path pierre gives the file.
// Data and stable callbacks only: the composer rides in as its own
// prop, so typing a message never changes this object's identity and
// the rail rows keyed off it stay cached.
export interface DiffChangesControls {
  files: ChangedFile[];
  // Status row by the path the patch names the file under. Rename rows
  // are keyed by their destination, which is also what pierre puts in
  // `name`.
  byPath: ReadonlyMap<string, ChangedFile>;
  onSetStaged: (paths: string[], staged: boolean) => void;
  onDiscard: (paths: string[]) => void;
  // A commit or discard is in flight: checkboxes and discard controls
  // hold still until the tree settles.
  busy: boolean;
}

export function fileMapByPath(
  files: readonly ChangedFile[],
): ReadonlyMap<string, ChangedFile> {
  return new Map(files.map((file) => [file.path, file]));
}

// The working-tree paths a row stands for, for staging and discarding.
// A rename is two paths in the index (the deletion and the addition),
// and both have to move together or the pair splits into a stray D and
// a stray untracked file.
export function changedFilePaths(file: ChangedFile): string[] {
  return file.prevPath ? [file.prevPath, file.path] : [file.path];
}

// What a commit right now would take: every file with anything staged.
export function includedFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return files.filter((file) => file.staged !== "none");
}
