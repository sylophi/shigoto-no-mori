import type { ChangedFile } from "@shigomori/contracts/schemas/index";
import type { ChangesPicks } from "./changesPicks.ts";
import type { HunkControls } from "./HunkBarView.tsx";

// What turns the read-only diff view into the changes page: the status
// rows the file list draws, which of them is in the pane, and the actions
// the rows fire. Data and stable callbacks only. The composer rides in
// as its own prop, so typing a message never changes this object's
// identity.
export interface DiffChangesControls {
  files: readonly ChangedFile[];
  // The first status read hasn't answered yet: `files` is empty because
  // nothing is known, not because the tree is clean.
  loading: boolean;
  // That first read failed, so the list is empty for want of an answer.
  failed: boolean;
  // What is ticked (changesPicks), and ticking rows in or out.
  picks: ChangesPicks;
  onSetTicked: (rows: readonly ChangedFile[], ticked: boolean) => void;
  onDiscard: (paths: string[]) => void;
  // Every change, untracked files included, into a stash.
  onStash: () => void;
  // The picked file's hunks, when it ticks by hunk (a modified file).
  hunks?: HunkControls;
  // Settle a conflicted file with one side's version, or as it stands.
  onResolve: (path: string, side: "mine" | "theirs" | "as-is") => void;
  // The row whose diff is in the pane (patchFiles.changeKey), and how
  // to change it. The page owns this because the page fetches that
  // file's diff.
  selectedKey: string | null;
  onSelect: (key: string) => void;
  // A commit or discard is in flight: checkboxes and discard controls
  // hold still until the tree settles.
  busy: boolean;
  // A peer that takes no commands from here: the list only reads, with
  // no ticks, discards, stash or conflict moves.
  readOnly: boolean;
}

// The working-tree paths a row stands for, for committing and discarding.
// A rename is two paths in the index (the deletion and the addition),
// and both have to move together or the pair splits into a stray D and
// a stray untracked file.
export function changedFilePaths(file: ChangedFile): string[] {
  return file.prevPath ? [file.prevPath, file.path] : [file.path];
}
