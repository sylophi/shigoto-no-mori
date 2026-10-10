// How a worktree's sidebar row looks right now (useWorktreeEntry reads
// it): the open one, what runs in it, a delete in flight.
import type { ScriptActivityKind } from "../../lib/scriptRun.ts";

export interface WorktreeRowLook {
  isSelected: boolean;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
}

// What is happening in a worktree right now, if anything. A delete in
// flight outranks a running script: it spans the cleanup scripts and
// the final git remove, while the script activity covers only cleanup,
// so the trash stays up for the whole mutation.
export function activityMark(
  look: Pick<WorktreeRowLook, "activity" | "isDeleting">,
): ScriptActivityKind | null {
  return look.isDeleting ? "teardown" : look.activity;
}
