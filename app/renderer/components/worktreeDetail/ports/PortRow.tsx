// One port of a worktree (PortRowView), with the forward's band under a
// remote scope where this client can forward.
import type { ComponentProps } from "react";
import type { PortForwardWorktree } from "@shigomori/contracts/modules/portForward";
import { useCanForwardPorts } from "@/hooks/remote/usePortForwards";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { ForwardControl } from "./ForwardControl";
import {
  forwardBandClass,
  PortRowView,
} from "@shigomori/ui/views/worktreeDetail/ports/PortRowView.tsx";

export function PortRow({
  deviceId,
  worktree,
  granted,
  ...props
}: Omit<ComponentProps<typeof PortRowView>, "forward" | "deviceLabel"> & {
  deviceId: string;
  worktree: PortForwardWorktree;
  granted: boolean;
}) {
  const canForwardPorts = useCanForwardPorts();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  return (
    <PortRowView
      {...props}
      deviceLabel={deviceLabel}
      forward={
        props.remote &&
        canForwardPorts && (
          <ForwardControl
            deviceId={deviceId}
            remotePort={props.entry.port}
            worktree={worktree}
            listening={props.entry.listening}
            granted={granted}
            className={forwardBandClass(props.plain ?? false)}
          />
        )
      }
    />
  );
}
