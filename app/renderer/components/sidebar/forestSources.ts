// What the forest is built from: this machine's projects and their
// listings, every peer's forest, and the device filter's narrowing of
// them. One hook for the sidebar and the home page's grid of projects
// (home/ProjectGrid.tsx), so the grid lists the very projects the
// sidebar's list does, in its order, narrowed the same way.
import { useAllProjectShigomoriConfigs } from "@/hooks/config/useShigomoriConfig";
import { useAllProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useProjects } from "@/hooks/projects/useProjects";
import {
  useGroupProjectsByOwner,
  useProjectSort,
} from "@/hooks/projects/useProjectSort";
import { useMirrorLinks } from "@/hooks/remote/useMirrors";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useAllowAgentWorking } from "@/hooks/config/useSidebarMarks";
import { useWorktreePrefixes } from "@/hooks/sharedSettings/useWorktreePrefixes";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";
import { localDeviceId } from "@/lib/queryKeys";
import { sortProjects } from "@/lib/sortProjects";
import { projectGroupOrder } from "./buildSidebarRows";
import { useDeviceBadges } from "./DeviceBadge";
import { useDeviceFilter } from "./deviceFilter";

export function useForestSources({
  arrangeMode = false,
  inboxFacts = false,
  warm = false,
}: {
  // Arranging is about this machine's project order and ignores the
  // filter.
  arrangeMode?: boolean;
  // The inbox's extra facts about the peers' worktrees.
  inboxFacts?: boolean;
  // Mounted beside the always-mounted sidebar, so its cache is warm:
  // read it rather than re-probing git for every project on mount.
  warm?: boolean;
} = {}) {
  const { data: projects = [], isLoading } = useProjects();
  const sortMode = useProjectSort();
  const groupByOwner = useGroupProjectsByOwner();
  // The inbox's and the queries' order (the tree re-sorts its groups
  // with projectGroupOrder). Drag-reorder still operates on the stored
  // order (`projects`), which is safe because dragging is gated to
  // arrange mode and arrange mode is only reachable via the manual sort,
  // where the orders match.
  const orderedProjects = sortProjects(projects, sortMode);
  // Subscribed here rather than inside the row builders so the two
  // views share one set of observers. Toggling the view then costs
  // nothing: the builders are plain functions over these results, and
  // the queries (which re-probe git for every project on mount) never
  // unmount.
  const worktreeQueries = useAllProjectWorktrees(
    orderedProjects,
    warm ? { refetchOnMount: false } : {},
  );
  const pullRequestQueries = useAllProjectPullRequests(orderedProjects);
  // Peers' forests, merged in beside the local rows.
  const { items: remoteItems, loading: remoteLoading } = useRemoteForests({
    refetchOnMount: !warm,
    inboxFacts,
  });
  const configQueries = useAllProjectShigomoriConfigs(orderedProjects);
  // This device's mirrored pairs, so a pair reads as one row.
  const mirrors = useMirrorLinks();
  // Off the registry, not the rows: a local row mirrored with a peer
  // the filter hides keeps naming it.
  const deviceBadges = useDeviceBadges();
  const hiddenPrefixes = useWorktreePrefixes("hidden");
  const groupedPrefixes = useWorktreePrefixes("grouped");
  const allowAgentWorking = useAllowAgentWorking();
  // The device filter narrows what the builders are handed rather than
  // what they do: one machine's rows only, the local ones or one
  // peer's. The queries above stay subscribed either way, so a pick
  // costs no refetch.
  const filter = useDeviceFilter();
  const activeFilter = arrangeMode ? null : filter.selected;
  const showLocal =
    activeFilter === null || activeFilter.deviceId === localDeviceId;
  // Hidden means empty, for every local input at once: the query
  // arrays too, since the builders count loading and failed listings
  // off them.
  const local = showLocal
    ? {
        projects: orderedProjects,
        worktreeQueries,
        pullRequestQueries,
        configQueries,
      }
    : {
        projects: [],
        worktreeQueries: [],
        pullRequestQueries: [],
        configQueries: [],
      };
  const shownRemote =
    activeFilter === null
      ? remoteItems
      : remoteItems.filter((item) => item.deviceId === activeFilter.deviceId);
  return {
    // The stored order, which dragging writes.
    projects,
    orderedProjects,
    loading: isLoading || remoteLoading,
    sortMode,
    groupByOwner,
    worktreeQueries,
    remoteItems,
    // Over every device's projects, not the filtered ones, so a pick
    // narrows the tree without reordering it.
    order: projectGroupOrder({
      projects: orderedProjects,
      remote: remoteItems,
      sortMode,
    }),
    local,
    shownRemote,
    mirrors,
    deviceBadges,
    hiddenPrefixes,
    allowAgentWorking,
    groupedPrefixes,
    filter,
    activeFilter,
  };
}
