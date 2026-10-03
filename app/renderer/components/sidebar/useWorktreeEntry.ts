// What the two sidebar rows share in behaviour (their shared look is
// WorktreeEntryView): "am I the open one", "what's running here", "where
// does a click go", "what do I say on hover", who lives here and which
// ports are forwarded from it have the same answers in the tree and the
// inbox, and answering them twice is how the two silently drift.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useShowDeviceBadges } from "@/hooks/config/useSidebarMarks";
import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";
import { useWorktreeScriptActivity } from "@/hooks/scripts/useScriptRuns";
import { useResident } from "@/hooks/villagers/useResident";
import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import {
  fillRoutePath,
  routeDeviceId,
  WORKTREE_ROUTE_PATHS,
} from "@/lib/routePaths";
import type { Worktree } from "@shared/schemas";
import { rowTitle } from "./rowState";
import type { WorktreeEntryViewProps } from "./WorktreeEntryView";

export function useWorktreeEntry(
  worktree: Worktree,
  // The peer a remote row belongs to. Absent, the row is this
  // machine's.
  deviceId?: string,
): Pick<
  WorktreeEntryViewProps,
  "look" | "resident" | "forwardTip" | "showDeviceBadges"
> & { onClick: () => void } {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const running = useWorktreeScriptActivity(worktree.id, deviceId);
  const isDeleting = useIsDeletingWorktree(worktree.id, deviceId);
  const resident = useResident(worktree);
  // Only a peer's worktree can be forwarded from, and no forward names
  // an empty device.
  const forwardTip = useWorktreeForwardTip(deviceId ?? "", worktree);
  const showDeviceBadges = useShowDeviceBadges();
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
    look: {
      isSelected,
      activity,
      isDeleting,
      title: rowTitle(activity, isDeleting, worktree.shelved),
    },
    onClick: () => void navigate({ to: route, params }),
    resident,
    forwardTip,
    showDeviceBadges,
  };
}
