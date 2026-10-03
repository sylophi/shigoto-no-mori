// Forward any port from a peer to this machine.
// The worktree detail's port row covers the port a worktree already
// has. This is the arbitrary-port arm, and the two share the list and
// the start/stop pair in usePortForwards.
//
// Drawn as a strip of chips under the device, like the Launch chips on
// a worktree page (PortForwardSectionView): each live forward is a chip
// that opens in the browser, with its own Stop, and one quiet "Forward
// a port" chip unfolds into the port field only when asked. Nothing
// here is a form until the user wants one.
//
// The two halves have DIFFERENT preconditions, which is why the block
// renders on either one alone:
//   - Starting a forward drives a grant-gated verb on the peer, so it
//     needs command access there (`canStart`, resolved for every row at
//     once by the registry rather than per row).
//   - A live forward is a listener on THIS machine. It outlives the peer
//     going to sleep, and stopping it never touches the peer -- so the
//     list stays, with its Stop, even once `canStart` is false. Dropping
//     it there would strand the local port bound until the app quit,
//     with nothing left in the UI to release it.
// Both halves are app-only, since the engine binds a real TCP listener
// in the desktop main process and the web loopback rejects the
// portForward channels. The caller gates that.
import { usePortForwards } from "@/hooks/remote/usePortForwards";
import { PortForwardSectionView } from "./PortForwardSectionView";

export function PortForwardSection({
  deviceId,
  canStart,
}: {
  deviceId: string;
  canStart: boolean;
}) {
  const { forwards, start, stop } = usePortForwards(deviceId);
  return (
    <PortForwardSectionView
      forwards={forwards}
      canStart={canStart}
      startPending={start.isPending}
      stopPending={stop.isPending}
      onStart={(remotePort, onStarted) =>
        start.mutate({ remotePort }, { onSuccess: onStarted })
      }
      onStop={(forwardId) => stop.mutate(forwardId)}
    />
  );
}
