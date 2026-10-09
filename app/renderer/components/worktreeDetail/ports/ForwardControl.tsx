// A remote port's forward (ForwardControlView), driven on this machine:
// the switch, and the local port it lands on.
import { useState } from "react";
import type { PortForwardWorktree } from "@shigomori/contracts/modules/portForward";
import { useForwardLocalPort } from "@/hooks/config/useForwardLocalPort";
import { usePortForwardControl } from "@/hooks/remote/usePortForwards";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { ForwardControlView } from "./ForwardControlView";

export function ForwardControl({
  deviceId,
  remotePort,
  listening,
  worktree,
  granted,
  className,
}: {
  deviceId: string;
  remotePort: number;
  // The worktree whose port list this is, recorded on the forward.
  worktree: PortForwardWorktree;
  listening: boolean;
  granted: boolean;
  className?: string;
}) {
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const { forward, apply, isPending, error, clearError } =
    usePortForwardControl(deviceId, remotePort, worktree);
  const { localPort: preferred, setLocalPort } = useForwardLocalPort(
    deviceId,
    remotePort,
  );
  // A live forward being relocated to another local port, so the
  // state word says so instead of reading the old forward as a stop.
  const [pendingMove, setPendingMove] = useState(false);
  const live = forward !== undefined;
  const localPort = live ? forward.localPort : preferred;
  return (
    <ForwardControlView
      deviceLabel={deviceLabel}
      remotePort={remotePort}
      localPort={localPort}
      live={live}
      pending={
        !isPending ? null : !live ? "start" : pendingMove ? "move" : "stop"
      }
      connCount={forward?.connCount ?? 0}
      listening={listening}
      granted={granted}
      error={error}
      onLocalPort={(next) => {
        clearError();
        if (live) {
          setPendingMove(true);
          apply(
            { on: true, localPort: next },
            {
              onSuccess: () => setLocalPort(next),
              onSettled: () => setPendingMove(false),
            },
          );
        } else {
          setLocalPort(next);
        }
      }}
      onToggle={(on) => {
        clearError();
        if (on) apply({ on: true, localPort });
        else apply({ on: false });
      }}
      className={className}
    />
  );
}
