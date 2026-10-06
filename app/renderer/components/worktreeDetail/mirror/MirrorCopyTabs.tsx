// The device tabs a mirrored worktree's header leads with: one per
// device holding a side of the pair, the original first and an arrow
// to its copy, each pill naming its side the way the manage dialog's
// pair does (MirrorManageDialog PairStrip). The sidebar folds the pair
// into one row (this device's), so these are the way onto the other
// side's page, whose launchers, terminal and scripts run on that
// device. Unlike the project pages' tabs, a pick here navigates: each
// side is a worktree of its own, with its own route, so the page stays
// one device's throughout. Absent for a worktree with no mirror, or
// while the other side's ids are not yet known (only a served stream
// says so, which names no project).
import {
  DeviceTabBar,
  useDeviceRoster,
  type DeviceBarTab,
} from "@/components/shared/DeviceTabs";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  useWorktreeMirrorLinks,
  type MirrorCopyAt,
} from "@/hooks/remote/useMirrors";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import type { Worktree } from "@shared/schemas";

type Side = "original" | "copy";

// The other side's worktree rides along. Undefined for the page's own.
type SideTab = DeviceBarTab & { at: MirrorCopyAt | undefined };

export type MirrorCopies = { deviceId: string; tabs: SideTab[] };

// The sides to tab between, or null when there is no other to pick. A
// session runs on the device holding the original, so the runner of
// each link says which side each device is.
export function useMirrorCopies(worktree: Worktree): MirrorCopies | null {
  const { deviceId } = useHostScope();
  const links = useWorktreeMirrorLinks(worktree);
  const roster = useDeviceRoster();
  const others = new Map<string, { side: Side; at: MirrorCopyAt }>();
  for (const link of links) {
    if (link.otherCopy !== undefined && link.otherDeviceId !== deviceId) {
      others.set(link.otherDeviceId, {
        side: link.runnerDeviceId === deviceId ? "copy" : "original",
        at: link.otherCopy,
      });
    }
  }
  const ownSide: Side = links.some((link) => link.runnerDeviceId === deviceId)
    ? "original"
    : "copy";
  // In the roster's order within a side, so the devices sit as every
  // device pick has them.
  const originals: SideTab[] = [];
  const copies: SideTab[] = [];
  for (const entry of roster) {
    const other = others.get(entry.deviceId);
    if (entry.deviceId !== deviceId && other === undefined) continue;
    const side = other?.side ?? ownSide;
    (side === "original" ? originals : copies).push({
      ...entry,
      note: side,
      at: other?.at,
    });
  }
  if (originals.length + copies.length < 2) return null;
  const [firstCopy] = copies;
  if (firstCopy !== undefined && originals.length > 0) {
    firstCopy.arrowBefore = true;
  }
  return { deviceId, tabs: [...originals, ...copies] };
}

export function MirrorCopyTabs({ copies }: { copies: MirrorCopies }) {
  const { toDeviceWorktree } = useWorktreeNav();
  const { deviceId, tabs } = copies;
  return (
    <DeviceTabBar
      tabs={tabs}
      selectedId={deviceId}
      onSelect={(id) => {
        const at = tabs.find((tab) => tab.deviceId === id)?.at;
        if (at !== undefined) toDeviceWorktree(id, at.projectId, at.worktreeId);
      }}
    />
  );
}
