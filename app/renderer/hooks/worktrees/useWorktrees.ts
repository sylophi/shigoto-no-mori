import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";
import {
  useHostScope,
  type HostApi,
  type HostScope,
} from "@/hooks/remote/useHostScope";

// Which device's forest to read, and over which api. Both default to
// the local machine, so a scope-less call reads this machine's forest;
// a scoped caller (a useHostScope consumer, the sidebar's remote
// fan-out) passes a peer's id and api and that device's data caches
// under its own id.
export type HostForestScope = Partial<HostScope>;

// The (device, api) pair a scope names. The api falls back to
// window.api only when the KEY is absent (a scope-less local call): a
// caller passing `api: undefined` means "this device has no
// connection", and a default parameter would silently swap the local
// api in, so every offline device would fetch and cache THIS machine's
// data under its own device key.
export function resolveForestScope(scope: HostForestScope): {
  deviceId: string;
  api: HostApi | undefined;
} {
  return {
    deviceId: scope.deviceId ?? localDeviceId,
    api: "api" in scope ? scope.api : window.api,
  };
}

// Single source of truth for the worktrees-list query, so imperative
// fetches (e.g. queryClient.ensureQueryData) hit the same cache entry
// and config as the hooks below. The key registry is derived from the
// scope's device id, so the key and the queryFn can never name
// different devices.
export function worktreesQueryOptions(
  projectId: string | null,
  scope: HostForestScope = {},
) {
  const { deviceId, api } = resolveForestScope(scope);
  return queryOptions<readonly Worktree[]>({
    queryKey: queryKeysFor(deviceId).worktrees(projectId),
    queryFn: () => {
      if (!projectId || !api) return [];
      return api.worktrees.list({ projectId });
    },
    // Local: api and id are always present, so this is projectId !== null,
    // unchanged. Remote: an unconnected device (no api, empty id) never
    // fetches and the page renders its connecting or blocked state.
    enabled: projectId !== null && api !== undefined && deviceId !== "",
    // Four components observe this key and listing costs ~4 git subprocesses
    // per worktree. Without a window, opening the ⌘K palette re-lists every
    // project for data the sidebar just fetched. Short enough that focus
    // refetches and invalidations still behave as before.
    staleTime: 3_000,
    // Sidebar renders inline "Failed to list worktrees" + the project-
    // missing affordance handles the dominant ENOENT case.
    meta: { silentError: true },
  });
}

// Shared by the sidebar fan-outs. See useAllProjectWorktrees.
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
// Skip projects whose path is gone, since git would just ENOENT.
// Without a `combine`, useQueries hands back a fresh array of fresh
// objects every render, so nothing downstream can stay memoized.
// Projecting to the fields consumers read routes it through
// replaceEqualDeep, which keeps identity when nothing changed.
// Freshness overrides for a consumer that tolerates stale counts (the
// account page's chips) and must not re-list every project on mount or
// focus. Empty for everyone else, who keep the query's own defaults.
export type WorktreeFanOutRefetch = {
  staleTime?: number;
  refetchOnMount?: boolean;
  refetchOnWindowFocus?: boolean;
};

export function useAllProjectWorktrees(
  projects: readonly Project[],
  refetch: WorktreeFanOutRefetch = {},
) {
  const scope = useHostScope();
  return useQueries({
    queries: projects.map((project) => ({
      ...worktreesQueryOptions(project.id, scope),
      ...refetch,
      enabled: project.pathExists !== false,
    })),
    combine: combineFanOut,
  });
}
