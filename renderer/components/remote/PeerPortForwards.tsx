// The port-forward block for ONE peer, mounted from its registry row.
//
// The row is a display component handed plain facts, so this resolves
// the device itself off the same live registry the rest of the page
// reads (useRemoteDevice) rather than taking an api prop -- the same
// shape RemoteScope uses to scope a route's subtree, minus the routing.
// An api is present for exactly the reachable phases, so the guard here
// is also what keeps an asleep peer from rendering a dead form.
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { PortForwardSection } from "./PortForwardSection";

export function PeerPortForwards({ deviceId }: { deviceId: string }) {
  const device = useRemoteDevice(deviceId);
  if (device?.api === undefined) return null;
  return (
    <HostScopeProvider deviceId={deviceId} api={device.api}>
      <PortForwardSection />
    </HostScopeProvider>
  );
}
