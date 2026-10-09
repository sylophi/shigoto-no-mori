import { usePortForwards } from "@/hooks/remote/usePortForwards";
import { PortForwardSectionView } from "./PortForwardSectionView";

// A peer's port forwards (PortForwardSectionView), started and stopped
// through the forwards store.
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
      canStart={canStart}
      forwards={forwards}
      startPending={start.isPending}
      // Folding the field is the view's business, not the shared
      // mutation's.
      onStart={(remotePort, done) =>
        start.mutate({ remotePort }, { onSuccess: done })
      }
      stopPending={stop.isPending}
      onStop={(forwardId) => stop.mutate(forwardId)}
    />
  );
}
