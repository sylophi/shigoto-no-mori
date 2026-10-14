import { useQueryClient } from "@tanstack/react-query";
import { callOf } from "@shigomori/contracts/contract";
import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import type { Project } from "@shigomori/contracts/schemas";
import * as Atom from "effect/reactivity/Atom";
import type { QueryKeyRegistry } from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { hostViewAtom } from "@/lib/runtime/atoms";
import {
  useView,
  useViewErrorToast,
  useViews,
  viewsOf,
} from "@/lib/runtime/viewHooks";

// Every open page's read of a branch's PR in the project, asked again
// after a PR mutation (the map is the host's view, which the mutation
// itself moves).
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
// outcome into the page ahead of GitHub, so a page comparing itself
// with the map holds off while one runs (useWorktreePullRequest).
export function pullRequestMutationKey(keys: QueryKeyRegistry) {
  return keys.pullRequestsAll();
}

const pullRequestsAtom = Atom.family((key: string) => {
  const [deviceId = "", projectId = ""] = key.split("\n");
  return hostViewAtom({
    deviceId,
    view: callOf(githubCliContract, "watchProjectPullRequests"),
    input: { projectId },
  });
});

// A device's project, as the map's views are keyed.
export const pullRequestsKey = (deviceId: string, projectId: string) =>
  `${deviceId}\n${projectId}`;

// Every listed map of a device, for a caller that reads many projects.
export const somePullRequestsAtom = viewsOf(pullRequestsAtom);

// Branch -> PR for a project, feeding the sidebar dots: the host's view
// of the background fetch's sweep, which a page's own read of its
// branch's PR moves too (githubCli:worktreePullRequest). The open
// worktree page reads its PR through useWorktreePullRequest, and checks
// this map only to decide whether to hold the section's place while
// that loads.
export function useProjectPullRequests(projectId: string) {
  const { deviceId, hasHost } = useHostScope();
  const state = useView(
    hasHost ? pullRequestsAtom(pullRequestsKey(deviceId, projectId)) : null,
  );
  useViewErrorToast(state, "Couldn't load pull requests");
  return state;
}

// One view per project, sharing the per-project atom with
// useProjectPullRequests. The inbox sidebar is cross-project, so it
// needs every map at once to tell a merged branch from a live one.
// Projects whose path is gone are skipped, since the read would just
// fail on the missing repo. Positionally aligned with `projects`, like
// useAllProjectWorktrees.
export function useAllProjectPullRequests(projects: readonly Project[]) {
  const { deviceId, hasHost } = useHostScope();
  return useViews(
    somePullRequestsAtom,
    projects.map((project) =>
      hasHost && project.pathExists !== false
        ? pullRequestsKey(deviceId, project.id)
        : null,
    ),
  );
}
