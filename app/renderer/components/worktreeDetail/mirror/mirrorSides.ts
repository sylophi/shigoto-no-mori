// The sides of a mirror as the worktree page's tabs show them
// (MirrorCopyTabs): one per device holding a side, in the roster's
// order within a side, the originals ahead of the copies and an arrow
// before the first copy. A session runs on the device holding the
// original, so the runner of each link says which side each device
// is. Null when there is no other side to pick: no mirror, or the
// other side's ids not yet known (only a served stream says so, which
// names no project).
import type { DeviceRosterEntry } from "@/components/shared/DeviceTabs";
import type { DeviceBarTab } from "@/components/shared/DeviceTabBarView";
import type {
  MirrorCopyAt,
  WorktreeMirrorLink,
} from "@/hooks/remote/useMirrors";

type MirrorSide = "original" | "copy";

// The other side's worktree rides along. Undefined for the page's own.
export type MirrorSideTab = DeviceBarTab & { at: MirrorCopyAt | undefined };

export function mirrorSideTabs(
  links: readonly Pick<
    WorktreeMirrorLink,
    "runnerDeviceId" | "otherDeviceId" | "otherCopy"
  >[],
  deviceId: string,
  roster: readonly DeviceRosterEntry[],
): MirrorSideTab[] | null {
  const others = new Map<string, { side: MirrorSide; at: MirrorCopyAt }>();
  for (const link of links) {
    if (link.otherCopy !== undefined && link.otherDeviceId !== deviceId) {
      others.set(link.otherDeviceId, {
        side: link.runnerDeviceId === deviceId ? "copy" : "original",
        at: link.otherCopy,
      });
    }
  }
  const ownSide: MirrorSide = links.some(
    (link) => link.runnerDeviceId === deviceId,
  )
    ? "original"
    : "copy";
  const originals: MirrorSideTab[] = [];
  const copies: MirrorSideTab[] = [];
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
  return [...originals, ...copies];
}
