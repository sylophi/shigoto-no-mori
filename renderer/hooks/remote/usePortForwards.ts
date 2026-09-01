// The port-forward engine's control surface for one device: the forward
// list and the start/stop pair. Everything here is CLIENT-scoped and
// calls window.api directly: the listener belongs to THIS machine, only
// its target is the named device. The list caches under one client key
// for all devices, and this hook filters to the one asked for, so both
// the devices page's per-peer section and the worktree detail's port row
// render off the same query and the same error wording.
//
// The device is a plain argument, not a read off the surrounding host
// scope, because nothing here needs that device to be REACHABLE -- a
// forward outlives the peer going to sleep, and stopping one is a purely
// local act. Taking it from a scope would have tied the stop control to
// an api the caller does not need.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";

// Forwarding binds a real local TCP listener, which only the app can do
// -- the capability gate for every surface that offers a forward, kept
// here so the mechanism and its precondition travel together.
export const canForwardPorts = window.api.isElectron;

// The engine broadcasts on every forward/conn change, so conn counts and
// engine-side teardowns (peer offline) render live. It also fires for
// this file's own mutations, so they never invalidate the list
// themselves (the broadcast-owns-invalidation rule, see
// renderer/hooks/account/useAccount.ts).
//
// Mounted ONCE from App.tsx, not per consumer: the devices page mounts a
// forward surface per peer, and a subscription each would turn one
// engine signal into N invalidations of the same key. Those do not
// collapse, since invalidateQueries cancels and restarts an in-flight
// refetch by default. The engine already coalesces conn bursts to one
// signal per 150ms, which a per-consumer listener would multiply
// straight back up.
export function useWatchPortForwards(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.portForward.onChanged(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.portForwards(),
        });
      }),
    [queryClient],
  );
}

export function usePortForwards(deviceId: string) {
  const { data } = useQuery({
    queryKey: queryKeys.portForwards(),
    queryFn: () => window.api.portForward.list(),
    meta: { silentError: true },
  });
  const start = useMutation({
    mutationFn: (remotePort: number) =>
      window.api.portForward.start({ deviceId, remotePort }),
    // The engine's start probe surfaces the coded errors here
    // (connect-failed, too-many-conns). Refusals surface centrally.
    onError: (err) => {
      if (!isCommandRefusedError(err)) {
        notifyError("Couldn't forward the port", err);
      }
    },
    meta: { silentError: true },
  });
  const stop = useMutation({
    mutationFn: (forwardId: string) => window.api.portForward.stop(forwardId),
    onError: (err) => {
      if (!isCommandRefusedError(err)) {
        notifyError("Couldn't stop forwarding", err);
      }
    },
    meta: { silentError: true },
  });
  return {
    forwards: (data?.forwards ?? []).filter(
      (forward) => forward.deviceId === deviceId,
    ),
    start,
    stop,
  };
}
