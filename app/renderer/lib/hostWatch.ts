// Push-driven upkeep of the requests (React Query) for ONE device, the
// same for this machine and every peer: the host's broadcasts, received
// over whatever wire the device's api rides, read again what they move
// in that device's cache. The boot calls it for this machine
// (renderer/boot.tsx) and remoteDeviceSync for each peer the moment it
// builds the peer's api. A bridge kept while these families are
// requests (decision 20): a project's git reads (its branches, a
// commit's or a stash's diff), a worktree's own (its data, files and
// changes), a project's settings and the launch tools, and, on its refs
// moving, an open page's pull request, none of which the host serves as
// a view. A family the host comes to serve as a view leaves it.
//
// No reachability gate on purpose: a push from a device IS that
// device's session speaking, and invalidating a device nothing caches
// under matches no query. Sessions are supervised desired state owned
// by the host's keeper (shared/hub/directKeeper.ts), and the session-landed
// sweep (remoteDeviceSync's noteSessions) covers whatever changed
// while a session was down, so this never needs to know a session's
// lifecycle.
//
// Not here: what the host serves as views (projects, worktrees,
// mirrors, running scripts, ports, terminals, the config, sharing and
// the shared settings are atoms that stream, and nothing invalidates
// them), a peer's shared settings (folded into this device's own copy,
// lib/remote/sharedSettingsSync.ts), and the pushes that are atoms of
// their own (the script runs, the worktree lifecycle, the git fetches).
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
