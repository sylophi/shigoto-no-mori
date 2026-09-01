// Push-driven cache invalidation for a remote device's forest (v2 step
// 6). The host pings git:externalChange after any app-driven mutation
// (main/ipc/register.ts) and for truly external writes via its fs
// watcher, and git:refsRefreshed narrows a background fetch to one
// project's branch state. Subscribing here (mounted once per open
// device scope, in RemoteScope) makes a peer's pages refresh on push
// instead of waiting out staleTime or a window focus.
//
// Deliberately NOT subscribed, so this stays two channels:
// - projects:usageBumped drives the local sidebar's usage sorts, which
//   a peer's pages don't drive.
// - git:fetchActive feeds the device-blind fetch-spinner store, which
//   would misattribute a remote host's sweep to the local forest.
// - githubCli's PR refresh: the githubCli domain is exempt from
//   external-change invalidation and not rendered remotely.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateBranchState } from "@/hooks/git/useBranches";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDevice } from "@/lib/remote/devices";
import { invalidateHostDevice, queryKeysFor } from "@/lib/queryKeys";

// Takes the device as a prop rather than reading useHostScope:
// RemoteScope mounts this in the same component that renders the
// HostScopeProvider, so it sits OUTSIDE that provider, and the status
// gate isn't part of the scope anyway.
export function useWatchRemoteHost(device: RemoteDevice): void {
  const queryClient = useQueryClient();
  const { deviceId, api } = device;
  // Gate on REACHABLE (a live direct session, or online in the roster
  // where main's keeper is already dialing one), NOT on `connected`:
  // sessions are supervised desired state, so an online device's
  // session is typically seconds away and the subscription should be
  // standing when it lands. A `connected` gate would also churn the
  // handlers on every direct-socket blip for nothing -- the keeper,
  // not this subscription, owns (re-)establishment.
  const reachable = deviceStatusView(device.status).reachable;
  useEffect(() => {
    if (!reachable || api === undefined) return;
    const unsubscribeExternalChange = api.git.onExternalChange(() => {
      invalidateHostDevice(queryClient, deviceId);
    });
    const unsubscribeRefsRefreshed = api.git.onRefsRefreshed(
      ({ projectId }) => {
        invalidateBranchState(queryClient, queryKeysFor(deviceId), projectId);
      },
    );
    return () => {
      unsubscribeExternalChange();
      unsubscribeRefsRefreshed();
    };
  }, [reachable, api, deviceId, queryClient]);
}
