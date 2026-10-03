// What a sidebar row shows of its worktree's state, which
// useWorktreeRowState works out. Its own module, apart from the router
// and the run store that hook reads, so the row's view
// (WorktreeEntryView) renders without the app.
import type { ScriptActivityKind } from "@/store/scriptRuns";

export interface WorktreeRowLook {
  isSelected: boolean;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
  // Hover title, or undefined when the row is in no state worth naming.
  // A tooltip that only repeats the branch already on screen is noise.
  title: string | undefined;
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
