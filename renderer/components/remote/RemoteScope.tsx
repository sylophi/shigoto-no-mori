// Route-level device scoping for the /devices/$deviceId/... twin
// routes: resolve the device from the registry, scope the subtree's
// queries to its api (HostScopeProvider), and say honestly when the
// device is not reachable. Push refresh is not a scope concern: the
// boot-scoped remote host watch
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
import { useLastGoodApi } from "@/hooks/remote/useLastGoodApi";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDevice } from "@/lib/remote/devices";

function RemoteScopeGate({
  deviceId,
  Page,
}: {
  deviceId: string;
  Page: ComponentType;
}) {
  const device = useRemoteDevice(deviceId);
  // Kept across a blip so the page under it stays mounted (why: the
  // hook). This matters twice here: a page opened on this device's
  // route can be showing ANOTHER device's tab (ProjectDevicePage picks
  // locally, without navigating), and that device is fine. The wrapper
  // keys this gate by deviceId, so the kept api never outlives a
  // navigation to a different device.
  const api = useLastGoodApi(device);

  // No session has ever been open on this device in this window (a
  // fresh open of a route for a device that is off), so there is
  // nothing to show under a banner: every query would be empty. A
  // device gone from the registry (removed from the account) is not a
  // blip either: its last state is nobody's to act on.
  if (api === undefined || device === undefined) {
    return <UnreachableDevice device={device} />;
  }

  return (
    <HostScopeProvider deviceId={deviceId} api={api}>
      <div className="flex h-full min-h-0 flex-col">
        {device?.api === undefined && <UnreachableBanner device={device} />}
        {/* The page keeps this slot whether or not the banner is up,
            so a blip re-renders it in place instead of remounting it,
            which is the entire point of holding the api. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <Page />
        </div>
      </div>
    </HostScopeProvider>
  );
}

function unreachableLabel(device: RemoteDevice | undefined): string {
  if (device === undefined)
    return "This device isn't in the account's registry.";
  if (device.status.phase === "blocked")
    return `Can't connect: ${device.status.message}.`;
  // The honest phase label ("Off", "Reconnecting", …), not a blanket
  // "Connecting" that lies for a stopped device.
  return `${device.label} is ${deviceStatusView(device.status).label.toLowerCase()}.`;
}

function UnreachableDevice({ device }: { device: RemoteDevice | undefined }) {
  return (
    <CenteredMessage className="flex-col gap-3">
      {unreachableLabel(device)}
      <OpenDevicesButton />
    </CenteredMessage>
  );
}

// The same message over a page that is still standing: what is on
// screen is the last thing the device sent, and anything acted on it
// will fail until the session is back.
function UnreachableBanner({ device }: { device: RemoteDevice | undefined }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
      <span className="min-w-0 flex-1 select-text">
        {unreachableLabel(device)} Showing the last state it sent.
      </span>
      <OpenDevicesButton />
    </div>
  );
}

function OpenDevicesButton() {
  const navigate = useNavigate();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void navigate({ to: "/devices" })}
    >
      Open Devices
    </Button>
  );
}

// Wraps a page component for mounting under a /devices/$deviceId twin
// route. The page reads its own params non-strictly, so the same
// component serves both the local route and this one. A lazy route
// component's preload rides along, so the router fetches its chunk
// ahead of the navigation instead of suspending the whole tree on it.
export function withRemoteScope(
  Page: ComponentType & { preload?: () => Promise<unknown> },
): () => ReactElement {
  // Keyed by device: not every twin route remounts on a params change,
  // and the gate's kept api must not survive a switch to another device.
  const RemoteScoped = () => {
    const { deviceId } = useParams({ strict: false }) as { deviceId: string };
    return <RemoteScopeGate key={deviceId} deviceId={deviceId} Page={Page} />;
  };
  return Object.assign(RemoteScoped, { preload: Page.preload });
}
