// The New worktree menu's projects: the tree's list of projects, so a
// repo checked out on several devices is one entry, in the tree's
// order and split by owner the same way. Kept apart from the menu so
// the proof can drive it (test/new-worktree-menu.mts).
import type { Project } from "@shigomori/contracts/schemas";
import type { HostApi } from "@/hooks/remote/useHostScope";
import type { RemoteForestItem } from "@shigomori/ui/lib/forest.ts";
import type { ProjectGroupOrder } from "@shigomori/ui/views/sidebar/buildSidebarRows.ts";
import { projectListSections } from "@shigomori/ui/views/sidebar/projectListSections.ts";
import type { ProjectSection } from "@shigomori/ui/views/sidebar/sidebarRow.ts";

// Every device's projects, whatever the device filter shows: creating
// is not browsing. Only the checkouts that can take a create are
// listed, so a project none of its devices can create in leaves the
// menu: missing on disk, or on peers that are asleep or haven't
// granted this device control (`commandableApi`).
export function buildCreateSections({
  projects,
  remote,
  order,
  byOwner,
  commandableApi,
}: {
  projects: readonly Project[];
  remote: RemoteForestItem[];
  order: ProjectGroupOrder;
  byOwner: boolean;
  commandableApi: (deviceId: string) => HostApi | undefined;
}): ProjectSection[] {
  return projectListSections({
    projects: projects.filter((project) => project.pathExists !== false),
    // The menu lists projects, not their worktrees.
    worktreeQueries: [],
    pullRequestQueries: [],
    order,
    hiddenPrefixes: [],
    allowAgentWorking: false,
    byOwner,
    remote: remote.flatMap((item) =>
      item.project.pathExists !== false &&
      commandableApi(item.deviceId) !== undefined
        ? [{ ...item, worktrees: [] }]
        : [],
    ),
    mirrors: [],
    deviceBadges: new Map(),
  });
}
