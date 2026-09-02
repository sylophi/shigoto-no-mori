import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { Project, ShigomoriConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";
import { combineFanOut } from "@/hooks/worktrees/useWorktrees";

function shigomoriConfigQueryOptions(projectId: string | null) {
  return queryOptions<ShigomoriConfig | null>({
    queryKey: queryKeys.shigomoriConfig(projectId),
    queryFn: () => {
      if (!projectId) return null;
      return window.api.shigomori.read(projectId);
    },
    enabled: projectId !== null,
    meta: { errorTitle: "Couldn't load project config" },
  });
}

export function useShigomoriConfig(projectId: string | null) {
  return useQuery(shigomoriConfigQueryOptions(projectId));
}

// Every project's config at once, for the inbox's per-project display
// options. Fan-out shape and combine rationale: useAllProjectWorktrees.
// Shares the cache key with useShigomoriConfig, so a Configure save
// reaches the sidebar through the same invalidation -- which is also
// why these never refetch on their own: every writer invalidates the
// key, and the external-change broadcast covers CLI edits.
export function useAllProjectShigomoriConfigs(projects: Project[]) {
  return useQueries({
    queries: projects.map((project) => ({
      ...shigomoriConfigQueryOptions(project.id),
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
