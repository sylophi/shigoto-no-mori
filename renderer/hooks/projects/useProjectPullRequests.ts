import { useEffect } from "react";
import {
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Project, PullRequest } from "@shared/schemas";
import {
  queryKeys,
  queryKeysFor,
  type QueryKeyRegistry,
} from "@/lib/queryKeys";
import {
  combineFanOut,
  resolveForestScope,
  type HostForestScope,
} from "@/hooks/worktrees/useWorktrees";
import { useHostScope } from "@/hooks/remote/useHostScope";

// Cascading invalidator: the shared key prefix knocks out both the
// sidebar map and any open per-branch detail in one call, so PR
// mutations can't desync the two layers by forgetting one.
export function invalidatePullRequestsForProject(
  qc: ReturnType<typeof useQueryClient>,
  keys: QueryKeyRegistry,
  projectId: string,
) {
  void qc.invalidateQueries({
    queryKey: keys.pullRequestsForProject(projectId),
  });
}

// Narrow invalidator for the sweep broadcast: the sweep already
// refreshed the project map in main, so the renderer just needs to
// pick that up. Cascading to per-branch would fire an extra `gh pr
// list --head` every minute when the detail page is open, even though
// the focus + refs-changed paths already keep that query fresh.
function invalidateProjectPullRequests(
  qc: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  void qc.invalidateQueries({
    queryKey: queryKeys.projectPullRequests(projectId),
  });
}

export function useWatchProjectPullRequests(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.githubCli.onProjectPullRequestsRefreshed(({ projectId }) => {
        invalidateProjectPullRequests(queryClient, projectId);
      }),
    [queryClient],
  );
}

// Branch -> PR for a project, feeding the sidebar dots. The background
// sweep in main/fetch.ts refreshes it and broadcasts
// GithubCliProjectPullRequestsRefreshed only when the data actually
// changed; useWatchProjectPullRequests invalidates this query off that
// broadcast. The open worktree page reads its PR through
// useWorktreePullRequest instead.
// Scope rule as worktreesQueryOptions: a peer's map caches under its
// own device id, and a device with no session never fetches.
export function projectPullRequestsQueryOptions(
  projectId: string,
  scope: HostForestScope = {},
) {
  const { deviceId, api } = resolveForestScope(scope);
  return queryOptions<Record<string, PullRequest>>({
    queryKey: queryKeysFor(deviceId).projectPullRequests(projectId),
    // Guarded by `enabled`.
    queryFn: () => api!.githubCli.projectPullRequests(projectId),
    enabled: api !== undefined && deviceId !== "",
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    meta: { errorTitle: "Couldn't load pull requests" },
  });
}

export function useProjectPullRequests(projectId: string) {
  const scope = useHostScope();
  return useQuery(projectPullRequestsQueryOptions(projectId, scope));
}

// One query per project, sharing the per-project cache key with
// useProjectPullRequests. The inbox sidebar is cross-project, so it
// needs every map at once to tell a merged branch from a live one.
// Main serves these from the sweep's cache, so the fan-out costs no
// extra `gh` calls. Projects whose path is gone are skipped -- the
// handler would just throw on the missing repo.
//
// Positionally aligned with `projects`, like useAllProjectWorktrees, so
// a caller walking both indexes them the same way.
// Same combine as useAllProjectWorktrees, and for the same reason.
export function useAllProjectPullRequests(projects: Project[]) {
  const scope = useHostScope();
  return useQueries({
    queries: projects.map((project) => ({
      ...projectPullRequestsQueryOptions(project.id, scope),
      enabled: project.pathExists !== false,
    })),
    combine: combineFanOut,
  });
}

export type ProjectPullRequestQueries = ReturnType<
  typeof useAllProjectPullRequests
>;
