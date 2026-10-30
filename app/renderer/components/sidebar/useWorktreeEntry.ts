import type { WorktreeEntry } from "@shigomori/ui/views/sidebar/WorktreeEntryView.tsx";

import { useMatch, useNavigate, useParams } from "@tanstack/react-router";

import { useWorktreeScriptActivity } from "@/hooks/scripts/useScriptRuns";

import { useWorktreeTerminalMark } from "@/hooks/terminals/useTerminals";

import { useRowHostApi } from "@/hooks/remote/useCommandAccess";

import { useIsDeletingWorktree } from "@/hooks/worktrees/useWorktreeMutations";

import type { Worktree } from "@shigomori/contracts/schemas";

import { useSidebarMarks } from "@/hooks/config/useSidebarMarks";

import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";

import { useResident } from "@/hooks/villagers/useResident";

import type { SidebarDeviceBadge } from "@shigomori/ui/views/sidebar/DeviceBadgeView.tsx";

import {
  routeDeviceId,
  WORKTREE_DETAIL_ROUTE_ID,
  WORKTREE_ROUTE_PATHS,
} from "@/lib/routePaths";
import { useApi } from "@/lib/runtime/pageApi";

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
  const localDeviceId = useApi().deviceId;
  const rowDeviceId = deviceId ?? localDeviceId;
  const navigate = useNavigate();
  const api = useRowHostApi(rowDeviceId);
  const running = useWorktreeScriptActivity(worktree.id, rowDeviceId, api);
  const terminal = useWorktreeTerminalMark(worktree.id, rowDeviceId, api);
  const isDeleting = useIsDeletingWorktree(worktree.id, deviceId);
  const params = {
    deviceId: routeDeviceId(localDeviceId, deviceId),
    projectId: worktree.projectId,
    worktreeId: worktree.id,
  };
  // The peer's copy sits in a project of its own id, so its page is
  // matched on device and worktree alone, and only for a mirrored row.
  const isSelected =
    useMatch({
      from: WORKTREE_DETAIL_ROUTE_ID,
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
    look: { isSelected, activity, terminal, isDeleting },
    open: () => void navigate({ to: WORKTREE_ROUTE_PATHS.detail, params }),
    resident,
    // Only a peer's worktree is forwarded from here.
    forwardTip: device ? forwardTip : undefined,
    marks: useSidebarMarks(),
  };
}
