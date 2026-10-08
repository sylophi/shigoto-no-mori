// The port-forward engine's control surface for one device: the forward
// list and the start/stop pair. Everything here is CLIENT-scoped and
// calls window.api directly: the listener belongs to THIS machine, only
// its target is the named device. The list caches under one client key
// for all devices, and these hooks filter to the one asked for, so both
// the account page's per-peer section and the worktree detail's port
// rows render off the same query and the same error wording.
//
// The device is a plain argument, not a read off the surrounding host
// scope, because nothing here needs that device to be REACHABLE -- a
// forward outlives the peer going to sleep, and stopping one is a purely
// local act. Taking it from a scope would have tied the stop control to
// an api the caller does not need.
import { type QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { CHANNEL_OPEN_TOO_MANY } from "@shigomori/contracts/channelRefusals";
import type {
  PortForwardSummary,
  PortForwardWorktree,
} from "@shigomori/contracts/modules/portForward";
import { isCommandRefusedError } from "@shigomori/contracts/errors";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { hasLocalHost } from "@/lib/localHost";

// Forwarding binds a real local TCP listener, which only the app can do
// -- the capability gate for every surface that offers a forward, kept
// here so the mechanism and its precondition travel together.
export const canForwardPorts = hasLocalHost;

// The engine broadcasts on every forward/conn change, so conn counts and
// engine-side teardowns (peer offline) render live. It also fires for
// this file's own mutations, so they never invalidate the list
// themselves (the broadcast-owns-invalidation rule, see
// renderer/hooks/account/useAccount.ts).
//
// Subscribed ONCE at boot (renderer/boot.tsx), not per consumer: the
// account page mounts a forward surface per peer, and a subscription
// each would turn one engine signal into N invalidations of the same
// key. Those do not collapse, since invalidateQueries cancels and
// restarts an in-flight refetch by default. The engine already
// coalesces conn bursts to one signal per 150ms, which a per-consumer
// listener would multiply straight back up.
export function watchPortForwards(queryClient: QueryClient): void {
  window.api.portForward.onChanged(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.portForwards(),
    });
  });
}

type PortForwardList = { readonly forwards: readonly PortForwardSummary[] };

// `select` narrows what a consumer re-renders on: the list refetches on
// every conn open and close, and a projection that comes out equal
// leaves its consumer alone.
function usePortForwardList<T = PortForwardList>(
  select?: (list: PortForwardList) => T,
) {
  return useQuery({
    queryKey: queryKeys.portForwards(),
    queryFn: () => window.api.portForward.list(),
    select,
    // The sidebar reads it on every peer row, and the web client's
    // loopback refuses the channel: nothing to ask there.
    enabled: canForwardPorts,
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
  if (message.startsWith(CHANNEL_OPEN_TOO_MANY)) {
    return "That device already has as many forwarded connections open as it allows.";
  }
  return message;
}

// Stopping a forward, from any surface that lists them. A purely
// local act, whatever the peer.
export function usePortForwardStop() {
  return useMutation({
    mutationFn: (forwardId: string) => window.api.portForward.stop(forwardId),
    meta: { errorTitle: "Couldn't stop forwarding" },
  });
}

export function usePortForwards(deviceId: string) {
  const { data } = usePortForwardList();
  const start = useMutation({
    mutationFn: (input: { remotePort: number; localPort?: number }) =>
      window.api.portForward.start({ deviceId, ...input }),
    // The engine's start probe surfaces the coded errors here
    // (too-many-conns). Refusals surface centrally.
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
  const stop = usePortForwardStop();
  return {
    forwards: (data?.forwards ?? []).filter(
      (forward) => forward.deviceId === deviceId,
    ),
    start,
    stop,
  };
}

// How many forwards this machine holds, for the sidebar's Live mark.
export function usePortForwardCount(): number {
  return usePortForwardList((list) => list.forwards.length).data ?? 0;
}

// Every forward this machine holds, whichever device it reaches: the
// Live page's list.
export function useAllPortForwards(): readonly PortForwardSummary[] {
  return usePortForwardList().data?.forwards ?? NO_FORWARDS;
}

const NO_FORWARDS: readonly PortForwardSummary[] = [];

// What the mark on a peer's worktree's sidebar row says while this
// machine forwards its ports, matched on the worktree each forward was
// switched on from (the note on the contract's worktree field).
// Undefined while nothing is forwarded.
export function useWorktreeForwardTip(
  deviceId: string,
  worktree: { projectId: string; id: string },
): string | undefined {
  const { data } = usePortForwardList((list) => {
    const pairs = list.forwards
      .filter(
        (forward) =>
          forward.deviceId === deviceId &&
          forward.worktree?.projectId === worktree.projectId &&
          forward.worktree.worktreeId === worktree.id,
      )
      .map(
        (forward) => `${forward.remotePort} to localhost:${forward.localPort}`,
      );
    return pairs.length > 0 ? `Forwarding ${pairs.join(", ")}` : undefined;
  });
  return data;
}

// One port's forward as a switch: `apply` asks the engine for the
// wanted state, off or on at a local port. The engine owns the rest: a
// start on a pair it already holds is a no-op, and one naming another
// local port moves the listener. One mutation, so the row has a single
// pending flag and a single error to show inline. Nothing here toasts:
// the row is the place the failure belongs.
export function usePortForwardControl(
  deviceId: string,
  remotePort: number,
  worktree: PortForwardWorktree,
) {
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
          worktree,
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
