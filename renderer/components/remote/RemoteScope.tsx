// Route-level device scoping for the /devices/$deviceId/... twin
// routes: resolve the device from the registry, keep the subtree's
// queries live over its api (HostScopeProvider + push refresh), and
// render honest connection states instead of the page when the device
// is not reachable. The wrapped page component is the SAME one the
// local route mounts: remoteness stays in the scope, never in the
// page (v2's core bet).
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ComponentType, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { CenteredMessage } from "@/components/ui/centered-message";
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { useWatchRemoteHost } from "@/hooks/remote/useWatchRemoteHost";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDevice } from "@/lib/remote/devices";

function RemoteScopeGate({ Page }: { Page: ComponentType }) {
  const { deviceId } = useParams({ strict: false }) as { deviceId: string };
  const device = useRemoteDevice(deviceId);

  if (device === undefined || device.api === undefined) {
    return <UnreachableDevice device={device} />;
  }
  return (
    <ScopedPage
      device={device}
      deviceId={deviceId}
      api={device.api}
      Page={Page}
    />
  );
}

function ScopedPage({
  device,
  deviceId,
  api,
  Page,
}: {
  device: RemoteDevice;
  deviceId: string;
  api: NonNullable<RemoteDevice["api"]>;
  Page: ComponentType;
}) {
  // Push-driven refresh while this device's pages are open, exactly
  // like the forest page: the host pings after mutating invokes and the
  // device-scoped cache invalidates in place.
  useWatchRemoteHost(device);
  return (
    <HostScopeProvider deviceId={deviceId} api={api}>
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
