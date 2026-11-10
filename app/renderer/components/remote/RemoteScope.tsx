// Route-level device scoping for the /devices/$deviceId/... pages:
// this machine's id renders the page under the default local scope
// (the page's api), a peer's resolves the device from the registry, scopes
// the subtree's queries to its api (DeviceScope), and says
// honestly when the device is not reachable. Push refresh is not a
// scope concern: every device's boot-scoped push watch
// (renderer/lib/hostWatch.ts) keeps its cache live, so the sidebar
// rows and these pages refresh the same way. The wrapped page
// component is the SAME for every device: remoteness stays in the
// scope, never in the page.
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ComponentType, ReactElement } from "react";
import {
  useAccountDevices,
  useAccountStatus,
} from "@/hooks/account/useAccount";
import { DeviceScope } from "@/hooks/remote/useHostScope";
import { useHasLocalHost } from "@/lib/localHost";
import { useApi } from "@/lib/runtime/pageApi";
import { type DeviceReach, useDeviceReach } from "@/hooks/remote/useDevices";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import { outdatedNote } from "@shigomori/ui/lib/outdatedCopy.ts";
import type { Device } from "@/lib/remote/devices";
import { UpdateOlder } from "./UpdateOlder";
import { NotSharingView } from "@shigomori/ui/views/remote/NotSharingView.tsx";
import {
  OpenDevicesButtonView,
  RemoteScopeFrameView,
  ScopeBannerView,
  UnreachableBannerView,
  UnreachableDeviceView,
} from "@shigomori/ui/views/remote/RemoteScopeView.tsx";

function RemoteScopeGate({
  deviceId,
  Page,
}: {
  deviceId: string;
  Page: ComponentType;
}) {
  const reach = useDeviceReach(deviceId);
  // Kept across a blip so the page under it stays mounted (why:
  // DeviceScope). This matters twice here: a page opened on this
  // device's route can be showing ANOTHER device's tab
  // (ProjectDevicePage picks locally, without navigating), and that
  // device is fine.
  return (
    <DeviceScope deviceId={deviceId} absent={<AbsentDevice reach={reach} />}>
      <RemoteScopeFrameView
        banner={
          reach.kind !== "live" ? (
            <UnreachableBannerView
              label={unreachableLabel(reach.device)}
              action={<AbsentAction device={reach.device} />}
            />
          ) : (
            "outdated" in reach.device.status && (
              <ScopeBannerView action={<UpdateOlder device={reach.device} />}>
                {outdatedNote(reach.device.label, reach.device.status)}
              </ScopeBannerView>
            )
          )
        }
      >
        <Page />
      </RemoteScopeFrameView>
    </DeviceScope>
  );
}

// Nothing a device that stopped sharing shared is kept, so there is no
// page to stand under a banner. Nor is there for a device that couldn't
// be asked since the gate opened (a fresh open of a route for a device
// that is off), where every query would be empty, or for one gone from
// the registry (removed from the account), whose last state is nobody's
// to act on.
function AbsentDevice({ reach }: { reach: DeviceReach }) {
  if (reach.kind === "notSharing") {
    return (
      <NotSharingView
        label={reach.device.label}
        action={<OpenDevicesButton />}
      />
    );
  }
  if (reach.kind === "gone") return <UnknownDevice />;
  return (
    <UnreachableDeviceView
      label={unreachableLabel(reach.device)}
      action={<AbsentAction device={reach.device} />}
    />
  );
}

// What a device that can't be asked offers: the update, where that is
// what stands between the two, and the account page otherwise.
function AbsentAction({ device }: { device: Device | undefined }) {
  return device !== undefined && "outdated" in device.status ? (
    <UpdateOlder device={device} />
  ) : (
    <OpenDevicesButton />
  );
}

function unreachableLabel(device: Device | undefined, signedIn = true): string {
  if (device === undefined) {
    // A deep link or a page left open across a sign-out: signed out,
    // nothing is in any registry.
    return signedIn
      ? "This device isn't in the account's registry."
      : "Sign in to reach this account's devices.";
  }
  if (device.status.phase === "blocked")
    return `Can't connect: ${device.status.message}.`;
  if (device.status.phase === "outdated")
    return outdatedNote(device.label, device.status);
  // The honest phase label ("Off", "Reconnecting", …), not a blanket
  // "Connecting" that lies for a stopped device.
  return `${device.label} is ${deviceStatusView(device.status).label.toLowerCase()}.`;
}

// A fresh load opens the route before the account and its device list
// are read, and a device missing from a list not read yet may well be
// on it: nothing is said until both are.
function UnknownDevice() {
  const status = useAccountStatus();
  const devices = useAccountDevices();
  if (status.isPending || devices.isPending) return null;
  return (
    <UnreachableDeviceView
      label={unreachableLabel(undefined, status.data?.signedIn === true)}
      action={<OpenDevicesButton />}
    />
  );
}

function OpenDevicesButton() {
  const hasLocalHost = useHasLocalHost();
  const navigate = useNavigate();
  return (
    <OpenDevicesButtonView
      desktop={hasLocalHost}
      onClick={() => void navigate({ to: "/account" })}
    />
  );
}

// Wraps a page component for mounting under a /devices/$deviceId
// route. The page reads its own params non-strictly, so the same
// component serves whichever route it is mounted on. A lazy route
// component's preload rides along, so the router fetches its chunk
// ahead of the navigation instead of suspending the whole tree on it.
export function withDeviceScope(
  Page: ComponentType & { preload?: () => Promise<unknown> },
): () => ReactElement {
  // A peer's gate is keyed by device: not every device route remounts
  // on a params change, and a page's own state (a form seeded from one
  // device's answers) must not carry over to another device. This
  // machine's page is a different element from any peer's gate, so a
  // switch between the two remounts it all the same.
  const DeviceScoped = () => {
    const { deviceId } = useParams({ strict: false }) as { deviceId: string };
    const localDeviceId = useApi().deviceId;
    if (deviceId === localDeviceId) return <Page />;
    return <RemoteScopeGate key={deviceId} deviceId={deviceId} Page={Page} />;
  };
  return Object.assign(DeviceScoped, { preload: Page.preload });
}
