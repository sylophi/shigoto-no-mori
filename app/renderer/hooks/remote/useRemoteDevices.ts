// React binding over the remote device registry (remoteDevicesAtom),
// so device status (connecting, connected, backoff, blocked) renders
// without any polling or prop threading. Read side only: no settings
// UI and no scoped data live here, just the live list the scoped
// surfaces resolve their device from.
import { UNNAMED_DEVICE } from "@shigomori/ui/lib/deviceRoster.ts";
import { useAtomValue } from "@effect/atom-react";
import {
  MACHINE_FALLBACK_ICON,
  type DeviceIcon,
} from "@shigomori/contracts/deviceIcon";
import {
  useLocalDeviceIcon,
  useLocalDeviceName,
} from "@/hooks/account/useAccount";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { useHasLocalHost } from "@/lib/localHost";
import { hostsProjects } from "@shigomori/ui/lib/deviceTraits.ts";
import {
  type RemoteDevice,
  type RemoteDeviceApi,
  remoteDevicesAtom,
} from "@/lib/remote/devices";
import { useApi } from "@/lib/runtime/pageApi";

// Live list of every registered remote device. Re-renders on any status
// or connection change: the list's reference is stable between changes
// (the sync rebuilds it only on a real change).
export function useRemoteDevices(): readonly RemoteDevice[] {
  return useAtomValue(remoteDevicesAtom);
}

const entryOf = (devices: readonly RemoteDevice[], deviceId: string) =>
  devices.find((entry) => entry.deviceId === deviceId);

// The account's machines: every registered device that hosts projects.
// A browser client is a device on the account too, but there is no
// host behind it to read config, updater state or a forest from, and
// neither is there behind a peer that isn't sharing.
export function useHostDevices(): readonly RemoteDevice[] {
  return useRemoteDevices().filter(
    (device) =>
      hostsProjects(device.platform) && device.status.phase !== "notSharing",
  );
}

// Every device that runs things, as (id, api) pairs: this machine when
// it hosts projects, then every peer that does, its api undefined while
// it has no session. The fan-outs across hosts (the mirror lists, the
// running scripts) all start from this list.
export function useEveryHost(): {
  deviceId: string;
  api: HostApi | undefined;
}[] {
  const page = useApi();
  const localDeviceId = page.deviceId;
  const hasLocalHost = useHasLocalHost();
  const devices = useHostDevices();
  return [
    ...(hasLocalHost ? [{ deviceId: localDeviceId, api: page }] : []),
    ...devices.map((device) => ({
      deviceId: device.deviceId,
      api: device.api,
    })),
  ];
}

// One registered device by id, live like the list. Undefined for the
// local device and for any id the registry doesn't know (a revoked peer,
// or a stale link into a device that left the account).
export function useRemoteDevice(deviceId: string): RemoteDevice | undefined {
  return useRemoteDevices().find((entry) => entry.deviceId === deviceId);
}

// One device's api, or undefined when it has no session (or the id
// names the local device, a revoked peer, or nothing at all). A
// selector, not a filter over useRemoteDevices: the api reference is
// stable per device (the sync compares it by identity), so a status
// transition on any peer leaves this value unchanged and React skips
// the render. Shared leaf hooks that draw at list scale (a project icon
// per row) read through this rather than subscribing to the whole
// roster. Pass undefined to subscribe to a constant.
export function useRemoteDeviceApi(
  deviceId: string | undefined,
): RemoteDeviceApi | undefined {
  return useAtomValue(remoteDevicesAtom, (devices) =>
    deviceId === undefined ? undefined : entryOf(devices, deviceId)?.api,
  );
}

// What a device looks like, by id, this device included: the account's
// answer for this machine, the registry's for a peer, and the fallback
// shape for an id the registry no longer knows (a revoked peer whose
// flow is still on screen), so a glyph always draws. A selector like
// useRemoteDeviceApi, so a peer's status churn leaves the string alone.
export function useDeviceIcon(deviceId: string): DeviceIcon {
  const localDeviceId = useApi().deviceId;
  const localIcon = useLocalDeviceIcon();
  const remoteIcon = useAtomValue(
    remoteDevicesAtom,
    (devices) => entryOf(devices, deviceId)?.icon ?? MACHINE_FALLBACK_ICON,
  );
  return deviceId === localDeviceId ? localIcon : remoteIcon;
}

// The device's name for prose ("on MacBook", "MacBook:3000").
export function useRemoteDeviceLabel(deviceId: string): string {
  return useRemoteDevice(deviceId)?.label ?? UNNAMED_DEVICE;
}

// The same for the device the caller's host scope reads.
export function useScopedDeviceLabel(): string {
  return useRemoteDeviceLabel(useHostScope().deviceId);
}

// Either party of a cross-device pair by name, where either may be
// this machine, which the registry does not list: "this device" for
// it, a peer's label otherwise.
export function useDeviceName(deviceId: string): string {
  const localDeviceId = useApi().deviceId;
  const label = useRemoteDevice(deviceId)?.label;
  if (deviceId === localDeviceId) return "this device";
  return label ?? UNNAMED_DEVICE;
}

// The same with this machine by its own name, for a title or a label
// that names a device outright ("Mirror with Studio Mac"), where "this
// device" would read as the party across.
export function useDeviceProperName(deviceId: string): string {
  const localDeviceId = useApi().deviceId;
  const name = useDeviceName(deviceId);
  const localName = useLocalDeviceName();
  return deviceId === localDeviceId ? localName : name;
}
