// Push-driven cache invalidation for a remote device's forest (v2 step
// 6). The host pings git:externalChange after any app-driven mutation
// (main/ipc/register.ts) and for truly external writes via its fs
// watcher, and git:refsRefreshed narrows a background fetch to one
// project's branch state. Subscribing here (mounted once in
// ConnectedForest, beside the listing queries) makes the remote page
// refresh on push instead of waiting out staleTime or a window focus.
//
// Deliberately NOT subscribed, so this stays two channels:
// - projects:usageBumped drives the local sidebar's usage sorts, which
//   the remote page doesn't render.
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
// ConnectedForest mounts this beside the listing queries, OUTSIDE the
// HostScopeProvider it renders, and the status gate isn't part of the
// scope anyway.
export function useWatchRemoteHost(device: RemoteDevice): void {
  const queryClient = useQueryClient();
  const { deviceId, api } = device;
  // Gate on REACHABLE (a live direct session, or online in the roster
  // where a use dials one), NOT on `connected`: subscribing while
  // merely online is exactly the dial-on-subscribe design, and the
  // subscription is what drives (re-)establishment. A `connected` gate
  // would defeat itself on a direct-socket drop: unmounting the
  // subscription removes this device from the transport's subscriber
  // counts and can release the very statusChanged listener whose
  // re-ensure would redial (renderer/lib/remote/relayTransport.ts).
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
