import { useLocation, useNavigate } from "@tanstack/react-router";
import { useWorktreeScriptActivity } from "@/hooks/scripts/useScriptRuns";
import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import type { ScriptActivityKind } from "@/store/scriptRuns";
import type { Worktree } from "@shared/schemas";
import {
  fillRoutePath,
  routeDeviceId,
  WORKTREE_ROUTE_PATHS,
} from "@/lib/routePaths";

export interface WorktreeRowState {
  isSelected: boolean;
  open: () => void;
  activity: ScriptActivityKind | null;
  isDeleting: boolean;
}

// What the two sidebar rows share in behaviour (their shared look is
// WorktreeEntry): "am I the open one", "what's running here" and
// "where does a click go" have the same answers in the tree and the
// inbox, and answering them twice is how the two silently drift.
// `deviceId` names the peer a remote row belongs to. Absent, the row
// is this machine's.
export function useWorktreeRowState(
  worktree: Worktree,
  deviceId?: string,
): WorktreeRowState {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const running = useWorktreeScriptActivity(worktree.id, deviceId);
  const isDeleting = useIsDeletingWorktree(worktree.id, deviceId);
  const params = {
    deviceId: routeDeviceId(deviceId),
    projectId: worktree.projectId,
    worktreeId: worktree.id,
  };
  const route = WORKTREE_ROUTE_PATHS.detail;
  // Not useMatchRoute: its stable function return reads from a hidden
  // store, which React Compiler can't see, so isSelected stays cached at
  // false. location.pathname is already decoded, so no encoding here.
  const detailPath = fillRoutePath(route, params);
  const isSelected = pathname === detailPath;
  // A failure is only news off the worktree's pages (its console, diff
  // and commits all sit under the detail path): on them it is on screen.
  const onScreen = isSelected || pathname.startsWith(`${detailPath}/`);
  const activity = running === "failed" && onScreen ? null : running;

  return {
    isSelected,
    open: () => void navigate({ to: route, params }),
    activity,
    isDeleting,
  };
}

// What is happening in a worktree right now, if anything. A delete in
// flight outranks a running script: it spans the cleanup scripts and
// the final git remove, while the script activity covers only cleanup,
// so the trash stays up for the whole mutation.
export function activityMark(
  state: Pick<WorktreeRowState, "activity" | "isDeleting">,
): ScriptActivityKind | null {
  return state.isDeleting ? "teardown" : state.activity;
}
