// The device tabs a mirrored worktree's header leads with: one per
// device holding a side of the pair, the original first and an arrow
// to its copy, each pill naming its side the way the manage dialog's
// pair does (MirrorManageDialog PairStrip). The sidebar folds the pair
// into one row (this device's), so these are the way onto the other
// side's page, whose launchers, terminal and scripts run on that
// device. Unlike the project pages' tabs, a pick here navigates: each
// side is a worktree of its own, with its own route, so the page stays
// one device's throughout.
import { useDeviceRoster } from "@/components/shared/DeviceTabs";
import { DeviceTabBarView } from "@shigomori/ui/views/shared/DeviceTabBarView.tsx";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeMirrorLinks } from "@/hooks/remote/useMirrors";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shigomori/contracts/schemas";
import { mirrorSideTabs, type MirrorSideTab } from "./mirrorSides";

export type MirrorCopies = { deviceId: string; tabs: MirrorSideTab[] };

// The sides to tab between (mirrorSides.ts), or null when there is no
// other to pick.
export function useMirrorCopies(worktree: Worktree): MirrorCopies | null {
  const { deviceId } = useHostScope();
  const links = useWorktreeMirrorLinks(worktree);
  const roster = useDeviceRoster();
  const tabs = mirrorSideTabs(links, deviceId, roster);
  return tabs === null ? null : { deviceId, tabs };
}

export function MirrorCopyTabs({ copies }: { copies: MirrorCopies }) {
  const { toDeviceWorktree } = useWorktreeNav();
  const { deviceId, tabs } = copies;
  return (
    <DeviceTabBarView
      tabs={tabs}
      selectedId={deviceId}
      onSelect={(id) => {
        const at = tabs.find((tab) => tab.deviceId === id)?.at;
        if (at !== undefined) toDeviceWorktree(id, at.projectId, at.worktreeId);
      }}
    />
  );
}
