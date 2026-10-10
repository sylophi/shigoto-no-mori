import type { WorktreeEntry } from "@shigomori/ui/views/sidebar/WorktreeEntryView.tsx";

import { useMatch, useNavigate, useParams } from "@tanstack/react-router";

import { useWorktreeScriptActivity } from "@/hooks/scripts/useScriptRuns";

import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";

import type { Worktree } from "@shigomori/contracts/schemas";

import { useSidebarMarks } from "@/hooks/config/useSidebarMarks";

import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";

import { useResident } from "@/hooks/villagers/useResident";

import type { SidebarDeviceBadge } from "@shigomori/ui/views/sidebar/DeviceBadgeView.tsx";

import { routeDeviceId, WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";

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
  const running = useWorktreeScriptActivity(worktree.id, deviceId);
  const isDeleting = useIsDeletingWorktree(worktree.id, deviceId);
  const params = {
    deviceId: routeDeviceId(deviceId),
    projectId: worktree.projectId,
    worktreeId: worktree.id,
  };
  const route = WORKTREE_ROUTE_PATHS.detail;
  // The peer's copy sits in a project of its own id, so its page is
  // matched on device and worktree alone, and only for a mirrored row.
  const isSelected =
    useMatch({
      from: route,
      shouldThrow: false,
      select: ({ params: open }) =>
        (open.deviceId === params.deviceId &&
          open.projectId === params.projectId &&
          open.worktreeId === params.worktreeId) ||
        (mirror.deviceId !== undefined &&
          open.deviceId === mirror.deviceId &&
          open.worktreeId === mirror.worktreeId),
    }) === true;
  // A failure is only news off the worktree's pages (its console, diff
  // and commits all sit under the detail path): on them it is on screen.
  // This device's pages alone: the peer copy's page shows its own runs.
  const onScreen = useParams({
    strict: false,
    select: (open) =>
      open.deviceId === params.deviceId &&
      open.projectId === params.projectId &&
      open.worktreeId === params.worktreeId,
  });
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
