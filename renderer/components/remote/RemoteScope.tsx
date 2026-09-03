// Route-level device scoping for the /devices/$deviceId/... twin
// routes: resolve the device from the registry, scope the subtree's
// queries to its api (HostScopeProvider), and render honest connection
// states instead of the page when the device is not reachable. Push
// refresh is not a scope concern: the boot-scoped remote host watch
// (renderer/lib/remote/remoteHostWatch.ts) invalidates every device's
// cache on its pings, so the sidebar rows and these pages refresh the
// same way. The wrapped page component is the SAME one the
// local route mounts: remoteness stays in the scope, never in the
// page (v2's core bet).
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ComponentType, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDevice } from "@/lib/remote/devices";

function RemoteScopeGate({ Page }: { Page: ComponentType }) {
  const { deviceId } = useParams({ strict: false }) as { deviceId: string };
  const device = useRemoteDevice(deviceId);

  if (device === undefined || device.api === undefined) {
    return <UnreachableDevice device={device} />;
  }
  return (
    <HostScopeProvider deviceId={deviceId} api={device.api}>
      <Page />
    </HostScopeProvider>
  );
}

function UnreachableDevice({ device }: { device: RemoteDevice | undefined }) {
  const navigate = useNavigate();
  const label =
    device === undefined
      ? "This device isn't in the account's registry."
      : device.status.phase === "blocked"
        ? `Can't connect: ${device.status.message}.`
        : // The honest phase label ("Off", "Reconnecting", …), not a
          // blanket "Connecting" that lies for a stopped device.
          `${device.label} is ${deviceStatusView(device.status).label.toLowerCase()}.`;
  return (
    <CenteredMessage className="flex-col gap-3">
      {label}
      <Button
        variant="outline"
        size="sm"
        onClick={() => void navigate({ to: "/devices" })}
      >
        Open Devices
      </Button>
    </CenteredMessage>
  );
}

// Wraps a page component for mounting under a /devices/$deviceId twin
// route. The page reads its own params non-strictly, so the same
// component serves both the local route and this one.
export function withRemoteScope(Page: ComponentType): () => ReactElement {
  return function RemoteScoped() {
    return <RemoteScopeGate Page={Page} />;
  };
}
