import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import { hostKeysFor } from "@/lib/queryKeys";

// The slice of the host api these options call. window.api and a remote
// device's api both satisfy it, so one options builder serves the local
// sidebar and the read-only remote forest without a parallel fork.
type WorktreeListApi = {
  worktrees: { list: (projectId: string) => Promise<Worktree[]> };
};

// Which device's forest to read, and over which api. Both default to the
// local machine, so every existing call site stays byte-identical: the
// key is hostKeysFor(localDeviceId) and the queryFn hits window.api.
export interface HostForestScope {
  deviceId?: string;
  api?: WorktreeListApi | undefined;
}

// Single source of truth for the worktrees-list query, so imperative
// fetches (e.g. queryClient.ensureQueryData) hit the same cache entry
// and config as the hooks below. The scope defaults to the local device,
// so remote callers pass a device id and api to read a peer's forest into
// its own cache slot under the same key shape.
export function worktreesQueryOptions(
  projectId: string | null,
  { deviceId = window.api.deviceId, api = window.api }: HostForestScope = {},
) {
  return queryOptions<Worktree[]>({
    queryKey: hostKeysFor(deviceId)("worktrees", projectId),
    queryFn: () => {
      if (!projectId || !api) return [];
      return api.worktrees.list(projectId);
    },
    // Local: api and id are always present, so this is projectId !== null,
    // unchanged. Remote: an unconnected device (no api, empty id) never
    // fetches and the page renders its connecting or blocked state.
    enabled: projectId !== null && api !== undefined && deviceId !== "",
    // Four components observe this key and listing costs ~4 git subprocesses
    // per worktree. Without a window, opening the launcher re-lists every
    // project for data the sidebar just fetched. Short enough that focus
    // refetches and invalidations still behave as before.
    staleTime: 3_000,
    // Sidebar renders inline "Failed to list worktrees" + the project-
    // missing affordance handles the dominant ENOENT case.
    meta: { silentError: true },
  });
}

// Shared by the two sidebar fan-outs; see useAllProjectWorktrees.
export function combineFanOut<T>(
  results: readonly {
    data: T | undefined;
    error: Error | null;
    isLoading: boolean;
    isPending: boolean;
  }[],
) {
  return results.map((result) => ({
    data: result.data,
    error: result.error,
    isLoading: result.isLoading,
    isPending: result.isPending,
  }));
}

export function useWorktrees(projectId: string | null) {
  return useQuery(worktreesQueryOptions(projectId));
}

// One query per project, sharing the per-project cache key with useWorktrees.
// `enabled` toggles them all off when the consumer isn't visible (launcher).
// Skip projects whose path is gone — git would just ENOENT.
// Without a `combine`, useQueries hands back a fresh array of fresh
// objects every render, so nothing downstream can stay memoized.
// Projecting to the fields consumers read routes it through
// replaceEqualDeep, which keeps identity when nothing changed.
export function useAllProjectWorktrees(projects: Project[], enabled = true) {
  return useQueries({
    queries: projects.map((project) => ({
      ...worktreesQueryOptions(project.id),
      enabled: enabled && project.pathExists !== false,
    })),
    combine: combineFanOut,
  });
}

// The shape useAllProjectWorktrees hands back, positionally aligned with
// the `projects` it was given. Named so the sidebar's row builders can
// take it as a plain argument instead of each calling the hook again.
export type ProjectWorktreeQueries = ReturnType<typeof useAllProjectWorktrees>;
