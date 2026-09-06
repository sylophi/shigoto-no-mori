import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project, ShigomoriConfig } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  combineFanOut,
  resolveForestScope,
  type HostForestScope,
} from "@/hooks/worktrees/useWorktrees";
import { queryKeysFor } from "@/lib/queryKeys";

// Scope rule as worktreesQueryOptions: a peer's config caches under its
// own device id, and a device with no session never fetches.
export function shigomoriConfigQueryOptions(
  projectId: string | null,
  scope: HostForestScope = {},
) {
  const { deviceId, api } = resolveForestScope(scope);
  return queryOptions<ShigomoriConfig | null>({
    queryKey: queryKeysFor(deviceId).shigomoriConfig(projectId),
    queryFn: () => {
      if (!projectId || !api) return null;
      return api.shigomori.read(projectId);
    },
    enabled: projectId !== null && api !== undefined && deviceId !== "",
    meta: { errorTitle: "Couldn't load project config" },
  });
}

export function useShigomoriConfig(projectId: string | null) {
  const scope = useHostScope();
  return useQuery(shigomoriConfigQueryOptions(projectId, scope));
}

// Every project's config at once, for the inbox's per-project display
// options. Fan-out shape and combine rationale: useAllProjectWorktrees.
// Shares the cache key with useShigomoriConfig, so a Configure save
// reaches the sidebar through the same invalidation -- which is also
// why these never refetch on their own: every writer invalidates the
// key, and the external-change broadcast covers CLI edits.
export function useAllProjectShigomoriConfigs(projects: Project[]) {
  const scope = useHostScope();
  return useQueries({
    queries: projects.map((project) => ({
      ...shigomoriConfigQueryOptions(project.id, scope),
      enabled: project.pathExists !== false,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      // An unreadable project.json would otherwise toast once per
      // project. The Configure page reports it when opened.
      meta: { silentError: true },
    })),
    combine: combineFanOut,
  });
}

export type ProjectShigomoriConfigQueries = ReturnType<
  typeof useAllProjectShigomoriConfigs
>;
