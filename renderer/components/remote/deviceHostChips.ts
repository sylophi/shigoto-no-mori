// The registry's "Hosts" data, gathered once for the whole page rather
// than per row: one hook call per row would mean one fan-out per row.
//
// Two sources, because the two halves of the account are read two
// different ways. THIS device's forest comes from the ordinary local
// projects/worktrees queries -- the same cache entries the sidebar
// already fills, so the strip costs nothing extra. Every peer's comes
// from useRemoteForests, the sidebar's merged-tree fan-out, for the
// same reason: the registry can never disagree with the tree because it
// is reading the tree's data.
import type { Project } from "@shared/schemas";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useAllProjectWorktrees } from "@/hooks/worktrees/useWorktrees";

// A chip count is decorative, so the local sweep rides whatever the
// sidebar's always-mounted listings already hold rather than re-running
// worktrees.list (~4 git subprocesses per worktree, for every project)
// on each visit to the page and every window focus. Same calm shape
// useRemoteForests gives the peers' half.
const CALM_REFETCH = {
  staleTime: 30_000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
};

export type HostChip = {
  projectId: string;
  name: string;
  worktrees: number;
};

export type HostChipIndex = {
  // deviceId -> that machine's projects. A device with no entry has no
  // projects registered (or has never been connected long enough to
  // say), which the row renders as the quiet empty line.
  byDevice: ReadonlyMap<string, HostChip[]>;
  // The local projects listing is still in flight.
  localLoading: boolean;
  // Some remote listing is still in flight. Only meaningful for a
  // reachable peer: a disconnected device's queries are disabled, so it
  // is never the one loading.
  remoteLoading: boolean;
};

export function useHostChipIndex(localDeviceId: string): HostChipIndex {
  const projectsQuery = useProjects();
  const localProjects: Project[] = projectsQuery.data ?? [];
  // Positionally aligned with localProjects, which is the contract
  // useAllProjectWorktrees documents.
  const localWorktrees = useAllProjectWorktrees(
    localProjects,
    true,
    CALM_REFETCH,
  );
  const forests = useRemoteForests();

  const byDevice = new Map<string, HostChip[]>();
  byDevice.set(
    localDeviceId,
    localProjects.map((project, index) => ({
      projectId: project.id,
      name: project.name,
      // A project whose worktree listing has not landed (or failed)
      // still deserves its chip; the count reads 0 until it does.
      worktrees: localWorktrees[index]?.data?.length ?? 0,
    })),
  );
  for (const item of forests.items) {
    const chips = byDevice.get(item.deviceId) ?? [];
    chips.push({
      projectId: item.project.id,
      name: item.project.name,
      worktrees: item.worktrees.length,
    });
    byDevice.set(item.deviceId, chips);
  }

  return {
    byDevice,
    localLoading: projectsQuery.isLoading,
    remoteLoading: forests.loading,
  };
}
