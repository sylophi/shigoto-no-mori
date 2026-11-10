// The account's devices with their live status: the peers, an atom
// remoteDeviceSync rebuilds wholesale from the device list and the
// hub's status, and the shape every reader sees them in, this machine
// among them (hooks/remote/useDevices.ts).
import * as Equal from "effect/Equal";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { CommandAccess } from "@shigomori/ui/lib/commandAccessCopy.ts";
import type { HostApi } from "@/lib/runtime/Api";
import type { RendererApi } from "@/lib/runtime/pageApi";
import { hostsProjects } from "@shigomori/ui/lib/deviceTraits.ts";
import {
  type DeviceStatusView,
  deviceStatusView,
  type RemoteDeviceStatus,
  THIS_DEVICE_NOT_RESPONDING_VIEW,
} from "@shigomori/ui/lib/deviceStatus.ts";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";

export type RemoteDevice = {
  // The remote host's device id, from the account registry (always
  // set). This is what hostKeysFor scopes a remote device's query cache
  // under.
  deviceId: string;
  // Display label: the account device name.
  label: string;
  // The registry's platform string (deviceTraits reads it), so a
  // surface can leave out a browser without a second registry read.
  platform: string;
  // What it looks like, off the registry row (every row has one), so
  // every mark for it draws through DeviceGlyphView with no second resolve.
  icon: DeviceIcon;
  status: RemoteDeviceStatus;
  // The remote host app's version, "" until the direct session's
  // welcome confirms it.
  appVersion: string;
  // Whether the peer runs this device's commands (its command-access
  // switch, HubStatus.peerAcceptsCommands), undefined until a direct
  // session is established and its dial's answer says. What every
  // read-only note and disabled control reads (useCommandAccess).
  acceptsCommands?: boolean;
};

// Any device as a surface reads it: this machine (its own name and
// icon, connected while its host answers the window and stopped while
// it doesn't) or a peer off the list above.
export type Device = Omit<RemoteDevice, "platform"> & {
  isThisDevice: boolean;
  // Whether a host stands behind it to read a forest, settings or runs
  // from: this machine on the desktop, a peer that is a machine.
  hostsProjects: boolean;
};

// A peer off the list, as a surface reads it.
export function peerOf(peer: RemoteDevice): Device {
  const { platform, ...rest } = peer;
  return {
    ...rest,
    isThisDevice: false,
    hostsProjects: hostsProjects(platform),
  };
}

// Whether a peer can be asked now: while its session is up, or while
// it's rostered with no session yet, since a call made while the direct
// plane's keeper (shared/hub/directKeeper.ts) dials joins the dial and
// remoteDeviceSync refetches when it lands.
export function isLiveStatus(status: RemoteDeviceStatus): boolean {
  return status.phase === "connected" || status.phase === "online";
}

// The same for any device: this machine always.
export function isLive(device: Device): boolean {
  return device.isThisDevice || isLiveStatus(device.status);
}

// A device's host modules: the page's for this machine, a peer's over
// the hub hop (lib/runtime/Api.ts), one object per device for the
// window's life.
export function apiOf(page: RendererApi, deviceId: string): HostApi {
  return deviceId === page.deviceId ? page : page.peerApi(deviceId);
}

// Its api while it can be asked, the shape the fan-outs hand on.
export function liveApi(
  page: RendererApi,
  device: Device,
): HostApi | undefined {
  return isLive(device) ? apiOf(page, device.deviceId) : undefined;
}

// Its state where a surface tags it. This machine shows none while its
// host answers (the glyph alone) and Not responding while it doesn't.
export function statusViewOf(device: Device): DeviceStatusView | null {
  if (!device.isThisDevice) return deviceStatusView(device.status);
  return device.status.phase === "connected"
    ? null
    : THIS_DEVICE_NOT_RESPONDING_VIEW;
}

const GRANTED: CommandAccess = {
  granted: true,
  isLoading: false,
  canCommand: true,
};
const PENDING: CommandAccess = {
  granted: false,
  isLoading: true,
  canCommand: true,
};
const REFUSED: CommandAccess = {
  granted: false,
  isLoading: false,
  canCommand: false,
};

// Whether this device may command a device, given its entry (undefined
// for a peer the list no longer knows). This machine commands itself,
// and a peer is pending until its session says.
export function commandAccessOf(
  device: Pick<Device, "isThisDevice" | "acceptsCommands"> | undefined,
): CommandAccess {
  if (device?.isThisDevice === true) return GRANTED;
  const accepts = device?.acceptsCommands;
  if (accepts === undefined) return PENDING;
  return accepts ? GRANTED : REFUSED;
}

// The list: a stable reference between changes, a new one on every
// change, which is what a reader's selector compares.
export const remoteDevicesAtom = Atom.keepAlive(
  Atom.make<readonly RemoteDevice[]>([]),
);

function sameDevice(a: RemoteDevice, b: RemoteDevice): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.label === b.label &&
    a.icon === b.icon &&
    a.appVersion === b.appVersion &&
    a.acceptsCommands === b.acceptsCommands &&
    // By value, so a new field of a status is compared with nothing to
    // update here.
    Equal.equals(a.status, b.status)
  );
}

// Unchanged entries keep their identity (keyed by deviceId), and an
// identical rebuild doesn't notify: most hub transitions change
// nothing.
export function setRemoteDevices(
  registry: AtomRegistry.AtomRegistry,
  devices: readonly RemoteDevice[],
): void {
  const snapshot = registry.get(remoteDevicesAtom);
  const previous = new Map(snapshot.map((device) => [device.deviceId, device]));
  let changed = devices.length !== snapshot.length;
  const next = devices.map((device, index) => {
    const old = previous.get(device.deviceId);
    const kept = old !== undefined && sameDevice(old, device) ? old : device;
    if (kept !== snapshot[index]) changed = true;
    return kept;
  });
  if (changed) registry.set(remoteDevicesAtom, next);
}

// A device by id as the list has it now, for a caller outside React.
export function remoteDeviceById(
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
): RemoteDevice | undefined {
  return registry
    .get(remoteDevicesAtom)
    .find((device) => device.deviceId === deviceId);
}
