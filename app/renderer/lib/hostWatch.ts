// Push-driven invalidation of one device's requests, for this machine
// (renderer/boot.tsx) and each peer (remoteDeviceSync): the families the
// host doesn't serve as views (EFFECT.md, section 10). No reachability
// gate: a push from a device is its session speaking, invalidating a
// device nothing caches under matches no query, and the session-landed
// sweep (remoteDeviceSync's noteSessions) covers what changed while one
// was down.
import { gitContract } from "@shigomori/contracts/modules/git";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateBranchState } from "@/hooks/git/useBranches";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { invalidateWorktreePullRequests } from "@/hooks/worktrees/useWorktreePullRequest";
import {
  invalidateHostDevice,
  invalidateHostProject,
  queryKeysFor,
} from "@/lib/queryKeys";

export type WatchedHostApi = Pick<HostApi, "pushes" | "listen">;

// Subscribes for as long as the device's api lives: this machine's for
// the life of the window, a peer's until the account is left (the
// returned unsubscribe).
export function watchHost(
  queryClient: QueryClient,
  deviceId: string,
  api: WatchedHostApi,
): () => void {
  const keys = queryKeysFor(deviceId);
  const { listen, pushes } = api;
  const unsubscribes = [
    // State changed on the device (an app-driven mutation, or a store
    // write from the terminal's `sm`): see invalidateHostDevice
    // for the breadth and exemption rationale.
    listen(pushes(gitContract, "externalChange"), () => {
      invalidateHostDevice(queryClient, deviceId);
    }),
    // One project's git state moved (a commit or checkout by an agent or
    // a terminal, seen by the host's git-directory watcher): read that
    // project's requests again only.
    listen(pushes(gitContract, "projectChanged"), ({ projectId }) => {
      invalidateHostProject(queryClient, deviceId, projectId);
    }),
    // A background fetch landed one project's refs: everything derived
    // from them, and the open worktree pages' PRs (a merge or a push is
    // what most often moves one, and the project's PR map, a view,
    // carries no mergeability). Scoped to that project: the sweep
    // broadcasts per project, so an unscoped invalidation would cost one
    // `gh pr view` per other project every sweep, each cancelling the
    // last.
    listen(pushes(gitContract, "refsRefreshed"), ({ projectId }) => {
      invalidateBranchState(queryClient, keys, projectId);
      invalidateWorktreePullRequests(queryClient, keys, projectId);
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
