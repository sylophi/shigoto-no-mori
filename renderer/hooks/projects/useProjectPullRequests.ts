import { useEffect } from "react";
import {
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  matchesMapEntry,
  type Project,
  type PullRequest,
  type PullRequestDetail,
} from "@shared/schemas";
import {
  isWorktreePullRequestKey,
  queryKeys,
  queryKeysFor,
  worktreePullRequestKeyBranch,
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

// Shared by the PR mutations (merge, draft toggle), which write their
// outcome into the page ahead of GitHub, so syncProjectPullRequests can
// hold off while one runs.
export function pullRequestMutationKey(keys: QueryKeyRegistry) {
  return keys.pullRequestsAll();
}

// Answer to the sweep broadcast: the sweep already refreshed the
// project map in main, so the renderer refetches that, then re-asks
// only the open worktree pages whose PR the new map disagrees with. A
// PR flipped to draft or ready (or merged) on github.com thus reaches
// an open page within a sweep, not at the next focus. Cascading to
// every per-branch query instead would fire an extra `gh pr list
// --head` per open page on every broadcast, most of them for PRs that
// didn't move. Also serves a peer's broadcast (remoteHostWatch), under
// that peer's keys.
export async function syncProjectPullRequests(
  qc: QueryClient,
  keys: QueryKeyRegistry,
  projectId: string,
): Promise<void> {
  const mapKey = keys.projectPullRequests(projectId);
  // "all": the comparison below needs the fresh map even when nothing
  // is observing it. Main serves it from the sweep's cache, no gh call.
  await qc.invalidateQueries({ queryKey: mapKey, refetchType: "all" });
  const map = qc.getQueryData<Record<string, PullRequest>>(mapKey);
  // A pending merge or draft toggle has written its optimistic result
  // into the page, which the map can't match yet. The mutation
  // refreshes the page itself when it settles.
  if (!map || qc.isMutating({ mutationKey: pullRequestMutationKey(keys) }))
    return;
  const pages = qc.getQueryCache().findAll({
    queryKey: keys.pullRequestsForProject(projectId),
    predicate: isWorktreePullRequestKey,
  });
  for (const page of pages) {
    const detail = page.state.data as PullRequestDetail | null | undefined;
    if (detail === undefined) continue;
    const entry = map[worktreePullRequestKeyBranch(page.queryKey)];
    // The map holds only the newest 200 PRs (host PR_LIST_LIMIT), so one
    // missing from it says nothing about that PR.
    if (detail !== null && entry === undefined) continue;
    // cancelRefetch: false leaves a fetch already in flight to land
    // rather than cancelling it and running the gh call again.
    if (!matchesMapEntry(detail, entry)) {
      void qc.invalidateQueries(
        { queryKey: page.queryKey, exact: true },
        { cancelRefetch: false },
      );
    }
  }
}

export function useWatchProjectPullRequests(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.githubCli.onProjectPullRequestsRefreshed(({ projectId }) => {
        void syncProjectPullRequests(queryClient, queryKeys, projectId);
      }),
    [queryClient],
  );
}

// Branch -> PR for a project, feeding the sidebar dots. The background
// sweep in main/electron/fetch.ts refreshes it and broadcasts
// GithubCliProjectPullRequestsRefreshed only when the data actually
// changed; useWatchProjectPullRequests invalidates this query off that
// broadcast. The open worktree page reads its PR through
// useWorktreePullRequest, and checks this map only to decide whether to
// hold the section's place while that loads.
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
// extra `gh` calls. Projects whose path is gone are skipped, since the
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
