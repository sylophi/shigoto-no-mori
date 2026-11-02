// The New worktree menu's projects: the tree's list of projects, so a
// repo checked out on several devices is one entry, in the tree's
// order and split by owner the same way.
import type { HostApi } from "@/hooks/remote/useHostScope";
import type { ForestItem } from "@shigomori/ui/lib/forest.ts";
import type { ProjectGroupOrder } from "@shigomori/ui/views/sidebar/projectGroupOrder.ts";
import { projectListSections } from "@shigomori/ui/views/sidebar/projectListSections.ts";
import type { ProjectSection } from "@shigomori/ui/views/sidebar/sidebarRow.ts";

// Every device's projects, whatever the device filter shows: creating
// is not browsing. Only the checkouts that can take a create are
// listed, so a project none of its devices can create in leaves the
// menu: missing on disk, or on peers that are asleep or haven't
// granted this device control (`commandableApi`).
export function buildCreateSections({
  items,
  order,
  byOwner,
  commandableApi,
}: {
  items: readonly ForestItem[];
  order: ProjectGroupOrder;
  byOwner: boolean;
  commandableApi: (deviceId: string) => HostApi | undefined;
}): ProjectSection[] {
  return projectListSections({
    // The menu lists projects, not their worktrees.
    items: items.flatMap((item) =>
      item.project.pathExists !== false &&
      (item.device.isThisDevice ||
        commandableApi(item.device.deviceId) !== undefined)
        ? [{ ...item, worktrees: [], listing: "ready" as const }]
        : [],
    ),
    deviceFilter: null,
    order,
    hiddenPrefixes: [],
    allowAgentWorking: false,
    byOwner,
    mirrors: [],
  });
}
