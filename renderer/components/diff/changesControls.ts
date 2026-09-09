import type { ChangedFile } from "@shared/schemas";

// What turns the read-only diff view into the changes page: the status
// rows the rail draws, which file of them is in the pane, and the
// actions the rows fire. The status list is the sole authority on what
// is changed, and every action names files by their row.
// Data and stable callbacks only: the composer rides in as its own
// prop, so typing a message never changes this object's identity and
// the rail rows keyed off it stay cached.
export interface DiffChangesControls {
  files: ChangedFile[];
  onSetStaged: (paths: string[], staged: boolean) => void;
  onDiscard: (paths: string[]) => void;
  // The file whose diff is in the pane, by path, and how to change it.
  // The page owns this because the page fetches that file's diff.
  selectedPath: string | null;
  onSelect: (path: string) => void;
  // A commit or discard is in flight: checkboxes and discard controls
  // hold still until the tree settles.
  busy: boolean;
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
