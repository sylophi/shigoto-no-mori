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
import {
  callOf,
  type ContractCall,
  payloadOf,
} from "@shigomori/contracts/contract";
import type { BroadcastPayload } from "@shigomori/contracts/types";
import { gitContract } from "@shigomori/contracts/modules/git";
import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { safeDecode } from "@shigomori/contracts/codec";
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

// The bridge forwards a peer's pushes wholesale, so a payload is parsed
// against the contract's own schema rather than trusted. This
// machine's go through the same check: one path, and it costs nothing.
function parsed<R extends ContractCall>(
  call: R,
  handler: (payload: BroadcastPayload<R>) => void,
): (payload: unknown) => void {
  return (payload) => {
    const result = safeDecode(payloadOf(call), payload);
    if (result.success) handler(result.data);
  };
}

export type WatchedHostApi = Pick<
  HostApi,
  "git" | "githubCli" | "mirror" | "projects" | "scripts" | "updater"
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
      parsed(callOf(gitContract, "projectChanged"), ({ projectId }) => {
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
      parsed(callOf(gitContract, "refsRefreshed"), ({ projectId }) => {
        invalidateBranchState(queryClient, keys, projectId);
        invalidateWorktreePullRequests(queryClient, keys, projectId);
      }),
    ),
    api.git.onFetchActive(
      parsed(callOf(gitContract, "fetchActive"), ({ projectId, active }) => {
        noteGitFetchActive(deviceId, projectId, active);
      }),
    ),
    // A project action was recorded there, so the usage sorts reorder
    // live.
    api.projects.onUsageBumped(
      parsed(callOf(projectsContract, "usageBumped"), () => {
        void queryClient.invalidateQueries({ queryKey: keys.projects() });
      }),
    ),
    // Its PR sweep moved one project's map. The githubCli domain sits
    // outside the git-state sweeps (a PR is not git state), so the
    // rows, inbox entries and any open page of its PRs refresh off this
    // alone.
    api.githubCli.onProjectPullRequestsRefreshed(
      parsed(
        callOf(githubCliContract, "projectPullRequestsRefreshed"),
        ({ projectId }) => {
          void syncProjectPullRequests(queryClient, keys, projectId);
        },
      ),
    ),
    // Its updater moved. The state rides the push whole, so it is
    // written rather than re-asked, and always on, so the update flags
    // (the sidebar's Settings dot, Settings' device tabs) follow a
    // check that finishes with no Version section mounted.
    api.updater.onState(
      parsed(callOf(updaterContract, "state"), (state) => {
        writeUpdaterState(queryClient, deviceId, state);
      }),
    ),
    // Its mirrors moved, the list riding the push whole (a host with
    // no list to send omits it, and it is re-asked). Always on, so the
    // sidebar's folds and a far end's page follow a device whose pages
    // were never opened.
    api.mirror.onChanged(
      parsed(callOf(mirrorContract, "changed"), (list) => {
        writeMirrorList(queryClient, deviceId, list);
      }),
    ),
    // A script started or ended there, whoever ran it: the Live page's
    // list and the sidebar's Live mark re-read.
    api.scripts.onChanged(
      parsed(callOf(scriptsContract, "changed"), () => {
        void queryClient.invalidateQueries({
          queryKey: keys.runningScripts(),
        });
      }),
    ),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
