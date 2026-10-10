import type { ReactNode } from "react";
import type { CommitSummary, Worktree } from "@shigomori/contracts/schemas";

// What may be done to one commit of the history list, as the app's
// lib/commitRewrite.ts works it out.
export interface CommitRewrite {
  canAmend: boolean;
  // The commit the list showed on top, which a reword or squash pins
  // HEAD to the way an undo does. Null when the move isn't allowed.
  reword: { head: string } | null;
  squash: { head: string } | null;
  // `head` is the commit the list showed on top. The reset is refused if
  // HEAD has moved since (a commit made in a terminal meanwhile), so an
  // undo never takes more than the rows it named.
  // `merge` when it undoes a merge on top: the branch goes back to how
  // it was before it, rather than its changes coming back staged.
  undo: { target: string; count: number; head: string; merge: boolean } | null;
}

// The history list's one set of moves on a commit, shared across rows,
// as the app's useCommitActions makes them.
export type CommitActions = {
  canCommand: boolean;
  undoTo: (undo: NonNullable<CommitRewrite["undo"]>) => void;
  canRevert: boolean;
  // The worktrees a commit can be cherry-picked onto.
  pickTargets: Worktree[];
  pending: boolean;
  revert: (commit: CommitSummary) => void;
  cherryPickInto: (target: Worktree, commit: CommitSummary) => void;
  newWorktreeFrom: (commit: CommitSummary) => void;
  squash: (commit: CommitSummary, head: string) => void;
  reword: (commit: CommitSummary, head: string) => void;
  // The reword dialog while one is open.
  dialog: ReactNode;
};
