// Push-driven cache upkeep for ONE device, the same for this machine
// and every peer: the host's broadcasts, received over whatever wire
// the device's api rides (this machine's preload bridge, a peer's
// direct session through the hub bridge's peerPush fan-out), land in
// that device's cache the same way. The boot calls it for this machine
// (renderer/boot.tsx) and remoteDeviceSync for each peer the moment it
// builds the peer's api, so the always-mounted sidebar rows for any
// device refresh the moment its state moves, whether or not one of its
// pages is open. Nothing else refetches an always-mounted query.
//
// No reachability gate on purpose: a push from a device IS that
// device's session speaking, and invalidating a device nothing caches
// under matches no query. Sessions are supervised desired state owned
// by main's keeper (shared/hub/directKeeper.ts), and the session-landed
// sweep (remoteDeviceSync's noteSessions) covers whatever changed
// while a session was down, so this never needs to know a session's
// lifecycle.
//
// Not here: the shared settings (a peer's copy is folded into this
// device's own, lib/remote/sharedSettingsSync.ts), and the per-device
// stores that keep a stream (store/scriptRuns.ts,
// store/worktreeLifecycle.ts).
import type { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import type { BroadcastDef } from "@shared/ipc/contract";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { mirrorContract } from "@shared/ipc/modules/mirror";
import { projectsContract } from "@shared/ipc/modules/projects";
import { updaterContract } from "@shared/ipc/modules/updater";
import { invalidateBranchState } from "@/hooks/git/useBranches";
import { noteGitFetchActive } from "@/hooks/git/useProjectGitFetching";
import { syncProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { writeMirrorList } from "@/hooks/remote/useMirrors";
import { writeUpdaterState } from "@/hooks/system/useUpdater";
import { invalidateWorktreePullRequests } from "@/hooks/worktrees/useWorktreePullRequest";
import {
  invalidateHostDevice,
  invalidateHostProject,
  queryKeysFor,
} from "@/lib/queryKeys";

const git = gitContract.calls;

// The bridge forwards a peer's pushes wholesale, so a payload is parsed
// against the contract's own schema rather than trusted. This
// machine's go through the same check: one path, and it costs nothing.
function parsed<S extends z.ZodTypeAny>(
  def: BroadcastDef<S>,
  handler: (payload: z.output<S>) => void,
): (payload: unknown) => void {
  return (payload) => {
    const result = def.payload.safeParse(payload);
    if (result.success) handler(result.data);
  };
}

export type WatchedHostApi = Pick<
  HostApi,
  "git" | "githubCli" | "mirror" | "projects" | "updater"
>;

// Subscribes for as long as the device's api lives: this machine's for
// the life of the window, a peer's until the account is left (the
// returned unsubscribe).
export function watchHost(
  queryClient: QueryClient,
  deviceId: string,
  api: WatchedHostApi,
): () => void {
  const keys = queryKeysFor(deviceId);
  const unsubscribes = [
    // State changed on the device (an app-driven mutation, or its fs
    // watcher seeing a CLI run in a terminal): see invalidateHostDevice
    // for the breadth and exemption rationale.
    api.git.onExternalChange(() => {
      invalidateHostDevice(queryClient, deviceId);
    }),
    // One project's git state moved (a commit or checkout by an agent or
    // a terminal, seen by the host's git-directory watcher): refetch
    // that project's rows only.
    api.git.onProjectChanged(
      parsed(git.projectChanged, ({ projectId }) => {
        invalidateHostProject(queryClient, deviceId, projectId);
      }),
    ),
    // A background fetch landed one project's refs: everything derived
    // from them, and the open worktree pages' PRs (a merge or a push is
    // what most often moves one). Scoped to that project: the sweep
    // broadcasts per project, so an unscoped invalidation would cost one
    // `gh pr view` per other project every sweep, each cancelling the
    // last.
    api.git.onRefsRefreshed(
      parsed(git.refsRefreshed, ({ projectId }) => {
        invalidateBranchState(queryClient, keys, projectId);
        invalidateWorktreePullRequests(queryClient, keys, projectId);
      }),
    ),
    api.git.onFetchActive(
      parsed(git.fetchActive, ({ projectId, active }) => {
        noteGitFetchActive(deviceId, projectId, active);
      }),
    ),
    // A project action was recorded there, so the usage sorts reorder
    // live.
    api.projects.onUsageBumped(
      parsed(projectsContract.calls.usageBumped, () => {
        void queryClient.invalidateQueries({ queryKey: keys.projects() });
      }),
    ),
    // Its PR sweep moved one project's map. The githubCli domain sits
    // outside the git-state sweeps (a PR is not git state), so the
    // rows, inbox entries and any open page of its PRs refresh off this
    // alone.
    api.githubCli.onProjectPullRequestsRefreshed(
      parsed(
        githubCliContract.calls.projectPullRequestsRefreshed,
        ({ projectId }) => {
          void syncProjectPullRequests(queryClient, keys, projectId);
        },
      ),
    ),
    // Its updater moved. The state rides the push whole, so it is
    // written rather than re-asked, and always on, so the update flags
    // (the sidebar's Settings dot, the Settings device rows) follow a
    // check that finishes with no Version section mounted.
    api.updater.onState(
      parsed(updaterContract.calls.state, (state) => {
        writeUpdaterState(queryClient, deviceId, state);
      }),
    ),
    // Its mirrors moved, the list riding the push whole (an older peer
    // sends none, and its list is re-asked). Always on, so the
    // sidebar's folds and a far end's page follow a device whose pages
    // were never opened.
    api.mirror.onChanged(
      parsed(mirrorContract.calls.changed, (list) => {
        writeMirrorList(queryClient, deviceId, list);
      }),
    ),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
