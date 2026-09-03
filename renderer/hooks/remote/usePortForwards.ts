// The port-forward engine's control surface for one device: the forward
// list and the start/stop pair. Everything here is CLIENT-scoped and
// calls window.api directly: the listener belongs to THIS machine, only
// its target is the named device. The list caches under one client key
// for all devices, and these hooks filter to the one asked for, so both
// the devices page's per-peer section and the worktree detail's port
// rows render off the same query and the same error wording.
//
// The device is a plain argument, not a read off the surrounding host
// scope, because nothing here needs that device to be REACHABLE -- a
// forward outlives the peer going to sleep, and stopping one is a purely
// local act. Taking it from a scope would have tied the stop control to
// an api the caller does not need.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessageOf } from "@shared/errors";
import {
  FORWARD_CONNECT_FAILED,
  FORWARD_TOO_MANY_CONNS,
} from "@shared/ipc/modules/forward";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";

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

function usePortForwardList() {
  return useQuery({
    queryKey: queryKeys.portForwards(),
    queryFn: () => window.api.portForward.list(),
    meta: { silentError: true },
  });
}

// The host's coded refusals (the FORWARD_* markers beside the contract)
// and node's bind errors (stable OS codes), in words a row can show
// inline. Anything else passes through as the engine said it.
export function describeForwardError(
  error: unknown,
  ports: { remotePort: number; localPort?: number },
): string {
  if (isCommandRefusedError(error)) {
    return peerReadOnlyNote();
  }
  const message = errorMessageOf(error);
  if (message.includes("EADDRINUSE")) {
    return `localhost:${ports.localPort ?? ports.remotePort} is already taken on this machine. Pick another local port.`;
  }
  if (message.includes("EACCES")) {
    return `localhost:${ports.localPort ?? ports.remotePort} needs elevated privileges here. Pick a port above 1024.`;
  }
  if (message.startsWith(FORWARD_CONNECT_FAILED)) {
    return `Nothing answered on port ${ports.remotePort} over there. Is the server running?`;
  }
  if (message.startsWith(FORWARD_TOO_MANY_CONNS)) {
    return "That device already has as many forwarded connections open as it allows.";
  }
  return message;
}

export function usePortForwards(deviceId: string) {
  const { data } = usePortForwardList();
  const start = useMutation({
    mutationFn: (input: { remotePort: number; localPort?: number }) =>
      window.api.portForward.start({ deviceId, ...input }),
    // The engine's start probe surfaces the coded errors here
    // (connect-failed, too-many-conns). Refusals surface centrally.
    onError: (err, input) => {
      if (!isCommandRefusedError(err)) {
        notifyError(
          "Couldn't forward the port",
          describeForwardError(err, input),
        );
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

// One port's forward as a switch: `apply` asks the engine for the
// wanted state, off or on at a local port. The engine owns the rest: a
// start on a pair it already holds is a no-op, and one naming another
// local port moves the listener. One mutation, so the row has a single
// pending flag and a single error to show inline. Nothing here toasts:
// the row is the place the failure belongs.
export function usePortForwardControl(deviceId: string, remotePort: number) {
  const { data } = usePortForwardList();
  const forward = data?.forwards.find(
    (entry) => entry.deviceId === deviceId && entry.remotePort === remotePort,
  );
  const apply = useMutation({
    mutationFn: async (
      target: { on: false } | { on: true; localPort: number },
    ) => {
      if (target.on) {
        await window.api.portForward.start({
          deviceId,
          remotePort,
          localPort: target.localPort,
        });
      } else if (forward !== undefined) {
        await window.api.portForward.stop(forward.forwardId);
      }
    },
    meta: { silentError: true },
  });
  const failed = apply.error;
  return {
    forward,
    apply: apply.mutate,
    isPending: apply.isPending,
    error:
      failed === null
        ? null
        : describeForwardError(failed, {
            remotePort,
            localPort: apply.variables?.on
              ? apply.variables.localPort
              : undefined,
          }),
    clearError: apply.reset,
  };
}
