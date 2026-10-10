import type { WorktreeEntry } from "@shigomori/ui/views/sidebar/WorktreeEntryView.tsx";

import { useLocation, useNavigate } from "@tanstack/react-router";

import { useWorktreeScriptActivity } from "@/hooks/scripts/useScriptRuns";

import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";

import type { Worktree } from "@shigomori/contracts/schemas";

import { useSidebarMarks } from "@/hooks/config/useSidebarMarks";

import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";

import { useResident } from "@/hooks/villagers/useResident";

import type { SidebarDeviceBadge } from "@shigomori/ui/views/sidebar/DeviceBadgeView.tsx";

import {
  fillRoutePath,
  matchRoutePath,
  routeDeviceId,
  WORKTREE_ROUTE_PATHS,
} from "@/lib/routePaths";

// What the two sidebar rows share in behaviour (their shared look is
// WorktreeEntryView): "am I the open one", "what's running here",
// "where does a click go" and which marks it wears have the same
// answers in the tree and the inbox, and answering them twice is how
// the two silently drift.
// `deviceId` names the peer a remote row belongs to. Absent, the row
// is this machine's. `mirror` names the peer's copy a local row stands
// for too: its page (reached by the copies' tabs on the worktree page)
// selects the row as well.
export function useWorktreeEntry(
  worktree: Worktree,
  device?: SidebarDeviceBadge,
  mirror: { deviceId?: string; worktreeId?: string } = {},
): WorktreeEntry {
  const deviceId = device?.deviceId;
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
  // The peer's copy sits in a project of its own id, so its page is
  // matched on device and worktree alone, and only for a mirrored row.
  const open =
    mirror.deviceId !== undefined && mirror.worktreeId !== undefined
      ? matchRoutePath(route, pathname)
      : null;
  const isSelected =
    pathname === detailPath ||
    (open !== null &&
      open.deviceId === mirror.deviceId &&
      open.worktreeId === mirror.worktreeId);
  // A failure is only news off the worktree's pages (its console, diff
  // and commits all sit under the detail path): on them it is on screen.
  // This device's pages alone: the peer copy's page shows its own runs.
  const onScreen =
    pathname === detailPath || pathname.startsWith(`${detailPath}/`);
  const activity = running === "failed" && onScreen ? null : running;

  const resident = useResident(worktree);
  const forwardTip = useWorktreeForwardTip(deviceId ?? "", worktree);
  return {
    look: { isSelected, activity, isDeleting },
    open: () => void navigate({ to: route, params }),
    resident,
    // Only a peer's worktree is forwarded from here.
    forwardTip: device ? forwardTip : undefined,
    marks: useSidebarMarks(),
  };
}
