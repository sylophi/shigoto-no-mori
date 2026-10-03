// What a sidebar row looks up for its view (WorktreeEntryView) beyond
// its state (useWorktreeRowState): the villager who lives in the
// worktree, the ports this machine forwards from it, and whether this
// window shows device badges on rows. Shared by the tree's row and the
// inbox's, so the two can't look these up differently.
import { useShowDeviceBadges } from "@/hooks/config/useSidebarMarks";
import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";
import { useResident } from "@/hooks/villagers/useResident";
import type { Worktree } from "@shared/schemas";
import type { WorktreeEntryViewProps } from "./WorktreeEntryView";

export function useWorktreeEntry(
  worktree: Worktree,
  // The peer the worktree lives on, absent for this machine's own.
  deviceId: string | undefined,
): Pick<
  WorktreeEntryViewProps,
  "resident" | "forwardTip" | "showDeviceBadges"
> {
  return {
    resident: useResident(worktree),
    // Only a peer's worktree can be forwarded from, and no forward
    // names an empty device.
    forwardTip: useWorktreeForwardTip(deviceId ?? "", worktree),
    showDeviceBadges: useShowDeviceBadges(),
  };
}
