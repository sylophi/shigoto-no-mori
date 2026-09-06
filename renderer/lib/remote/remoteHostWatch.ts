// Push-driven cache invalidation for EVERY remote device, boot-scoped
// like the local watcher subscription in renderer/index.tsx. A host
// pings git:externalChange after any app-driven mutation
// (main/ipc/register.ts) and for truly external writes via its fs
// watcher, git:projectChanged when one project's git state moves under
// any tool (its git-directory watcher), git:refsRefreshed narrows
// a background fetch to one project's branch state,
// remoteAccess:commandAccessChanged says the host's command-access
// switch flipped, and githubCli:projectPullRequestsRefreshed says its
// PR sweep found one project's map changed. All ride the peer's direct
// session and
// arrive here as the bridge's peerPush fan-out, tagged with the
// sending device, so one subscription serves every device and every
// surface: the always-mounted sidebar rows for a peer's forest refresh
// the moment that peer's state moves, whether or not one of its pages
// is open. A per-scope subscription (the old useWatchRemoteHost) left
// exactly those rows stale, since nothing else refetches an
// always-mounted query.
//
// No reachability gate on purpose: a push from a device IS that
// device's session speaking, and invalidating a device nothing caches
// under matches no query. Sessions are supervised desired state owned
// by main's keeper (shared/hub/directKeeper.ts), and the session-landed
// sweep (remoteDeviceSync's noteSessions) covers whatever changed
// while a session was down, so this subscription never needs to know a
// session's lifecycle.
//
// Deliberately NOT mirrored, so this stays five channels:
// - projects:usageBumped drives the local sidebar's usage sorts, which
//   a peer's rows don't drive.
// - git:fetchActive feeds the device-blind fetch-spinner store, which
//   would misattribute a remote host's sweep to the local forest.
import type { QueryClient } from "@tanstack/react-query";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { invalidateBranchState } from "@/hooks/git/useBranches";
import {
  invalidateHostDevice,
  invalidateHostProject,
  queryKeysFor,
} from "@/lib/queryKeys";

const EXTERNAL_CHANGE = gitContract.calls.externalChange;
const PROJECT_CHANGED = gitContract.calls.projectChanged;
const REFS_REFRESHED = gitContract.calls.refsRefreshed;
const COMMAND_ACCESS_CHANGED = remoteAccessContract.calls.commandAccessChanged;
const PULL_REQUESTS_REFRESHED =
  githubCliContract.calls.projectPullRequestsRefreshed;

// Boot wiring: subscribe once for the life of the window, never
// unsubscribed on purpose, exactly like the other boot-scope
// subscriptions. Both boots (renderer/boot.tsx, one for both shells)
// pass their own query client.
export function startRemoteHostWatch(queryClient: QueryClient): void {
  window.api.hub.onPeerPush(({ deviceId, channel, payload }) => {
    if (channel === EXTERNAL_CHANGE.channel) {
      invalidateHostDevice(queryClient, deviceId);
      return;
    }
    // The bridge forwards pushes wholesale, so a payload is parsed
    // here against the contract's own schema rather than trusted.
    if (channel === PROJECT_CHANGED.channel) {
      const parsed = PROJECT_CHANGED.payload.safeParse(payload);
      if (!parsed.success) return;
      invalidateHostProject(queryClient, deviceId, parsed.data.projectId);
      return;
    }
    // The peer's command-access switch moved: re-ask its preflight so
    // read-only notes and mutation controls follow without a focus.
    if (channel === COMMAND_ACCESS_CHANGED.channel) {
      void queryClient.invalidateQueries({
        queryKey: queryKeysFor(deviceId).commandAccess(),
      });
      return;
    }
    // The peer's PR sweep moved one project's map: the githubCli domain
    // sits outside the git-state sweeps (a PR is not git state), so the
    // peer's rows and inbox entries refresh off this alone, the way the
    // local map refreshes off the same broadcast on the local wire.
    if (channel === PULL_REQUESTS_REFRESHED.channel) {
      const parsed = PULL_REQUESTS_REFRESHED.payload.safeParse(payload);
      if (!parsed.success) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeysFor(deviceId).projectPullRequests(
          parsed.data.projectId,
        ),
      });
      return;
    }
    if (channel === REFS_REFRESHED.channel) {
      const parsed = REFS_REFRESHED.payload.safeParse(payload);
      if (!parsed.success) return;
      invalidateBranchState(
        queryClient,
        queryKeysFor(deviceId),
        parsed.data.projectId,
      );
    }
  });
}
