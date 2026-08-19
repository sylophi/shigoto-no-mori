import { useLocation, useNavigate } from "@tanstack/react-router";
import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import {
  useWorktreeScriptActivity,
  type ScriptActivityKind,
} from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";

export interface WorktreeRowState {
  isSelected: boolean;
  open: () => void;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
  // Hover title, or undefined when the row is in no state worth naming --
  // a tooltip that only repeats the branch already on screen is noise.
  title: string | undefined;
}

// What the two sidebar row layouts share. They look nothing alike -- one
// line of chrome in the tree, three in the inbox -- but "am I the open
// one", "what's running here", "where does a click go" and "what do I
// say on hover" have the same answers in both, and answering them twice
// is how the two silently drift.
export function useWorktreeRowState(worktree: Worktree): WorktreeRowState {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activity = useWorktreeScriptActivity(worktree.id);
  const isDeleting = useIsDeletingWorktree(worktree.id);
  // Not useMatchRoute: its stable function return reads from a hidden
  // store, which React Compiler can't see, so isSelected stays cached at
  // false. location.pathname is already decoded, so no encoding here.
  const isSelected =
    pathname === `/projects/${worktree.projectId}/worktrees/${worktree.id}`;

  return {
    isSelected,
    open: () =>
      void navigate({
        to: "/projects/$projectId/worktrees/$worktreeId",
        params: { projectId: worktree.projectId, worktreeId: worktree.id },
      }),
    activity,
    isDeleting,
    title: describeRow(activity, isDeleting, worktree.shelved),
  };
}

function describeRow(
  activity: ScriptActivityKind | null,
  isDeleting: boolean,
  shelved: boolean,
): string | undefined {
  if (isDeleting) return "Deleting worktree";
  if (activity === "setup") return "Running setup";
  if (activity === "teardown") return "Running teardown";
  if (activity === "package") return "Running a script";
  if (shelved) return "Shelved";
  return undefined;
}
