import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";
import { useHostScope, type HostScope } from "@/hooks/remote/useHostScope";

// Which device's forest to read, and over which api. Both default to
// the local machine, so a scope-less call reads this machine's forest;
// a scoped caller (a useHostScope consumer, the remote forest) passes a
// peer's id and api and that device's data caches under its own id.
export type HostForestScope = Partial<HostScope>;

// Single source of truth for the worktrees-list query, so imperative
// fetches (e.g. queryClient.ensureQueryData) hit the same cache entry
// and config as the hooks below. The key registry is derived from the
// scope's device id, so the key and the queryFn can never name
// different devices.
export function worktreesQueryOptions(
  projectId: string | null,
  scope: HostForestScope = {},
) {
  const deviceId = scope.deviceId ?? localDeviceId;
  // Key-presence check, not a default parameter: `api: undefined` from
  // a disconnected device must stay undefined (disabled query), not
  // fall back to the local api and cache this machine's worktrees
  // under the peer's device key. See projectsQueryOptions.
  const api = "api" in scope ? scope.api : window.api;
  return queryOptions<Worktree[]>({
    queryKey: queryKeysFor(deviceId).worktrees(projectId),
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
  const scope = useHostScope();
  return useQuery(worktreesQueryOptions(projectId, scope));
}

// One query per project, sharing the per-project cache key with useWorktrees.
// `enabled` toggles them all off when the consumer isn't visible (launcher).
// Skip projects whose path is gone — git would just ENOENT.
// Without a `combine`, useQueries hands back a fresh array of fresh
// objects every render, so nothing downstream can stay memoized.
// Projecting to the fields consumers read routes it through
// replaceEqualDeep, which keeps identity when nothing changed.
// Freshness overrides for a consumer that tolerates stale counts (the
// devices page's chips) and must not re-list every project on mount or
// focus. Empty for everyone else, who keep the query's own defaults.
export type WorktreeFanOutRefetch = {
  staleTime?: number;
  refetchOnMount?: boolean;
  refetchOnWindowFocus?: boolean;
};

export function useAllProjectWorktrees(
  projects: Project[],
  enabled = true,
  refetch: WorktreeFanOutRefetch = {},
) {
  const scope = useHostScope();
  return useQueries({
    queries: projects.map((project) => ({
      ...worktreesQueryOptions(project.id, scope),
      ...refetch,
      enabled: enabled && project.pathExists !== false,
    })),
    combine: combineFanOut,
  });
}

// The shape useAllProjectWorktrees hands back, positionally aligned with
// the `projects` it was given. Named so the sidebar's row builders can
// take it as a plain argument instead of each calling the hook again.
export type ProjectWorktreeQueries = ReturnType<typeof useAllProjectWorktrees>;
