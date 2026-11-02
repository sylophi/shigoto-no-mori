// The account's devices as every surface reads them: this machine
// first, then the peers off the list remoteDeviceSync keeps
// (lib/remote/devices.ts), live, with no polling or prop threading.
import { useAtomValue } from "@effect/atom-react";
import {
  MACHINE_FALLBACK_ICON,
  type DeviceIcon,
} from "@shigomori/contracts/deviceIcon";
import { UNNAMED_DEVICE } from "@shigomori/ui/lib/deviceRoster.ts";
import { useExternalStore } from "@shigomori/ui/lib/externalStore.ts";
import { useLocalDevice } from "@/hooks/account/useAccount";
import {
  type Device,
  isLive,
  liveApi,
  peerOf,
  remoteDevicesAtom,
} from "@/lib/remote/devices";
import type { HostApi } from "@/lib/runtime/Api";
import { hostAnswering } from "@/lib/runtime/hostAnswering";
import { useApi } from "@/lib/runtime/pageApi";

// This machine: its account name and icon, connected while its host
// answers the window.
function useThisDevice(): Device {
  const page = useApi();
  const local = useLocalDevice();
  const answering = useExternalStore(hostAnswering);
  return {
    deviceId: page.deviceId,
    label: local.name,
    icon: local.icon,
    status: { phase: answering ? "connected" : "stopped" },
    appVersion: page.appVersion,
    acceptsCommands: true,
    isThisDevice: true,
    hostsProjects: page.isElectron,
    api: page,
  };
}

// The other devices on the account.
export function usePeers(): Device[] {
  const page = useApi();
  return useAtomValue(remoteDevicesAtom).map((peer) => peerOf(page, peer));
}

export function useDevices(): Device[] {
  return [useThisDevice(), ...usePeers()];
}

// One device by id, live like the list. Undefined for an id the list
// doesn't know (a revoked peer, or a stale link into a device that left
// the account), and for undefined. A selector, so another peer's churn
// leaves the caller alone: shared leaf hooks that draw at list scale (a
// project icon per row) read through this.
export function useDevice(deviceId: string | undefined): Device | undefined {
  const page = useApi();
  const thisDevice = useThisDevice();
  const peer = useAtomValue(remoteDevicesAtom, (devices) =>
    devices.find((entry) => entry.deviceId === deviceId),
  );
  if (deviceId === page.deviceId) return thisDevice;
  return peer === undefined ? undefined : peerOf(page, peer);
}

// How a device can be reached from here: this machine, a peer that can
// be asked now, one that can't, one that shares nothing, or an id the
// list doesn't know.
export type DeviceReach =
  | { kind: "gone"; device: undefined }
  | { kind: "this" | "live" | "away" | "notSharing"; device: Device };

export function useDeviceReach(deviceId: string): DeviceReach {
  const device = useDevice(deviceId);
  if (device === undefined) return { kind: "gone", device };
  if (device.isThisDevice) return { kind: "this", device };
  if (device.status.phase === "notSharing") {
    return { kind: "notSharing", device };
  }
  return { kind: isLive(device) ? "live" : "away", device };
}

// The account's machines: the devices with a host behind them to read
// config, updater state or a forest from. A browser client is a device
// on the account too but hosts nothing, and neither does a peer that
// isn't sharing.
export function useHostDevices(): Device[] {
  return useDevices().filter(
    (device) => device.hostsProjects && device.status.phase !== "notSharing",
  );
}

// Every host as (id, api) pairs, its api undefined while it can't be
// asked. The fan-outs across hosts (the mirror lists, the running
// scripts) all start from this list.
export function useEveryHost(): {
  deviceId: string;
  api: HostApi | undefined;
}[] {
  return useHostDevices().map((device) => ({
    deviceId: device.deviceId,
    api: liveApi(device),
  }));
}

// One device's api while it can be asked, else undefined.
export function useLiveApi(deviceId: string | undefined): HostApi | undefined {
  const device = useDevice(deviceId);
  return device === undefined ? undefined : liveApi(device);
}

// What a device looks like, with the fallback shape for an id the list
// no longer knows (a revoked peer whose flow is still on screen), so a
// glyph always draws.
export function useDeviceIcon(deviceId: string): DeviceIcon {
  return useDevice(deviceId)?.icon ?? MACHINE_FALLBACK_ICON;
}

// A peer's name for prose ("on MacBook", "MacBook:3000").
export function useRemoteDeviceLabel(deviceId: string): string {
  const device = useDevice(deviceId);
  return device === undefined || device.isThisDevice
    ? UNNAMED_DEVICE
    : device.label;
}

// Either party of a cross-device pair by name: "this device" for this
// machine, a peer's label otherwise.
export function useDeviceName(deviceId: string): string {
  const device = useDevice(deviceId);
  if (device?.isThisDevice === true) return "this device";
  return device?.label ?? UNNAMED_DEVICE;
}

// The same with this machine by its own name, for a title or a label
// that names a device outright ("Mirror with Studio Mac"), where "this
// device" would read as the party across.
export function useDeviceProperName(deviceId: string): string {
  return useDevice(deviceId)?.label ?? UNNAMED_DEVICE;
}
