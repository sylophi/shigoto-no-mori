// What the forest is built from: every device's projects as items, this
// machine's mirrors, and the device filter's narrowing of them. One hook
// for the sidebar, the home page's grid of projects (home/ProjectGrid.tsx)
// and the palette, so the three list the very same projects, the grid in
// the list's order, narrowed the same way.
import { useAllProjectShigomoriConfigs } from "@/hooks/config/useShigomoriConfig";
import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useProjects } from "@/hooks/projects/useProjects";
import {
  useGroupProjectsByOwner,
  useProjectSort,
} from "@/hooks/projects/useProjectSort";
import { useMirrorLinks } from "@/hooks/remote/useMirrors";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useClientFlag } from "@/hooks/config/useSidebarMarks";
import { usePinnedProjects } from "@/hooks/sharedSettings/usePinnedProjects";
import { useProjectFolders } from "@/hooks/sharedSettings/useProjectFolders";
import { useWorktreePrefixes } from "@/hooks/sharedSettings/useWorktreePrefixes";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  type ForestItem,
  type LocalSide,
  localSidesWith,
} from "@shigomori/ui/lib/forest.ts";
import { showPrimaryInInbox } from "@shigomori/ui/lib/showPrimaryInInbox.ts";
import { sortProjects } from "@shigomori/ui/lib/sortProjects.ts";
import { projectGroupOrder } from "@shigomori/ui/views/sidebar/projectGroupOrder.ts";
import { useDeviceBadges, useThisDevice } from "./deviceBadges";
import { useDeviceFilter } from "./deviceFilter";
import { useApi } from "@/lib/runtime/pageApi";

export function useForestSources({
  arrangeMode = false,
  inboxFacts = false,
}: {
  // Arranging is about this machine's project order and ignores the
  // filter.
  arrangeMode?: boolean;
  // The inbox's extra facts about the peers' worktrees.
  inboxFacts?: boolean;
} = {}) {
  const localDeviceId = useApi().deviceId;
  const { data: projects = [], isLoading } = useProjects();
  const sortMode = useProjectSort();
  const groupByOwner = useGroupProjectsByOwner();
  const pinned = usePinnedProjects();
  const folders = useProjectFolders();
  // The inbox's and the queries' order (the tree re-sorts its groups
  // with projectGroupOrder). Drag-reorder still operates on the stored
  // order (`projects`), which is safe because dragging is gated to
  // arrange mode and arrange mode is only reachable via the manual sort,
  // where the orders match.
  const orderedProjects = sortProjects(projects, sortMode);
  // Read here rather than inside the row builders so the views share
  // one set of reads. Toggling the view then costs nothing: the
  // builders are plain functions over these results.
  const worktreeQueries = useAllProjectWorktrees(orderedProjects);
  const pullRequestQueries = useAllProjectPullRequests(orderedProjects);
  const configQueries = useAllProjectShigomoriConfigs(orderedProjects);
  const remote = useRemoteForests({ inboxFacts });
  // This device's mirrored pairs, so a pair reads as one row.
  const mirrors = useMirrorLinks();
  // Off the registry, not the rows: a local row mirrored with a peer
  // the filter hides keeps naming it.
  const deviceBadges = useDeviceBadges();
  const thisDevice = useThisDevice();
  const hiddenPrefixes = useWorktreePrefixes("hidden");
  const groupedPrefixes = useWorktreePrefixes("grouped");
  const allowAgentWorking = useClientFlag("allowAgentWorking");
  const filter = useDeviceFilter();
  const activeFilter = arrangeMode ? null : filter.selected;
  // Every device's projects as one list, this machine's first. Only
  // this machine's listing reports loading or failing, and only it keeps
  // a project whose folder is gone, which the peers' reads leave out.
  const items: ForestItem[] = [
    ...orderedProjects.map((project, i): ForestItem => {
      const query = worktreeQueries[i];
      return {
        device: thisDevice,
        project,
        worktrees: query?.data ?? [],
        listing: query?.isLoading
          ? "loading"
          : query?.error
            ? "error"
            : "ready",
        pullRequests: pullRequestQueries[i]?.data ?? {},
        showPrimaryInInbox: showPrimaryInInbox(configQueries[i]?.data),
      };
    }),
    ...remote.items,
  ];
  // The device filter narrows what the builders are handed rather than
  // what they do: one machine's items only. The reads above stay
  // subscribed either way, so a pick costs no refetch.
  const shownItems =
    activeFilter === null
      ? items
      : items.filter((item) => item.device.deviceId === activeFilter.deviceId);
  // Narrowed to a peer, this device's sides of its pairs with it, which
  // the builders list among the peer's rows.
  const localSides =
    activeFilter === null || activeFilter.deviceId === localDeviceId
      ? new Map<string, LocalSide>()
      : localSidesWith(
          activeFilter.deviceId,
          mirrors,
          orderedProjects,
          worktreeQueries,
          configQueries,
        );
  return {
    // The stored order, which dragging writes.
    projects,
    loading: isLoading || remote.loading,
    devicesFailed: remote.devicesFailed,
    // Failed listings on every device, whatever the filter shows.
    failedListings:
      worktreeQueries.filter((query) => query.error).length +
      remote.listingsFailed,
    sortMode,
    groupByOwner,
    items,
    shownItems,
    // Over every device's projects, not the filtered ones, so a pick
    // narrows the tree without reordering it.
    order: projectGroupOrder({ items, sortMode, pinned, folders }),
    localSides,
    mirrors,
    deviceBadges,
    hiddenPrefixes,
    allowAgentWorking,
    groupedPrefixes,
    filter,
    activeFilter,
  };
}
