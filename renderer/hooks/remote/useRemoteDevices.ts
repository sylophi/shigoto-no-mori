// React binding over the remote device registry.
// useSyncExternalStore subscribes a component to the registry's live
// snapshot, so device status (connecting, connected, backoff, blocked)
// renders without any polling or prop threading. Read side only: no
// settings UI and no scoped data live here, just the live snapshot the
// scoped surfaces resolve their device from.
import { useSyncExternalStore } from "react";
import {
  MACHINE_FALLBACK_KIND,
  type DeviceKind,
} from "@shared/account/deviceKind";
import { useLocalDeviceKind } from "@/hooks/account/useAccount";
import { localDeviceId } from "@/lib/queryKeys";
import { hostsProjects } from "@/lib/remote/deviceTraits";
import {
  type RemoteDevice,
  type RemoteDeviceApi,
  remoteDeviceStore,
} from "@/lib/remote/devices";

// Live list of every registered remote device. Re-renders on any status
// or connection change. The snapshot reference is stable between changes
// (the registry rebuilds it only on a real change), so this is safe as a
// useSyncExternalStore value.
export function useRemoteDevices(): readonly RemoteDevice[] {
  return useSyncExternalStore(
    remoteDeviceStore.subscribe,
    remoteDeviceStore.getSnapshot,
    remoteDeviceStore.getSnapshot,
  );
}

// The account's machines: every registered device that hosts projects.
// A browser client is a device on the account too, but there is no
// host behind it to read config, updater state or a forest from.
export function useHostDevices(): readonly RemoteDevice[] {
  return useRemoteDevices().filter((device) => hostsProjects(device.platform));
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
// stable per device (the store compares it by identity), so a status
// transition on any peer leaves this value unchanged and React skips
// the render. Shared leaf hooks that draw at list scale (a project icon
// per row) read through this rather than subscribing to the whole
// roster. Pass undefined to subscribe to a constant.
export function useRemoteDeviceApi(
  deviceId: string | undefined,
): RemoteDeviceApi | undefined {
  const select = () =>
    deviceId === undefined
      ? undefined
      : remoteDeviceStore
          .getSnapshot()
          .find((entry) => entry.deviceId === deviceId)?.api;
  return useSyncExternalStore(remoteDeviceStore.subscribe, select, select);
}

// What a device looks like, by id, this device included: the account's
// answer for this machine, the registry's for a peer, and the fallback
// shape for an id the registry no longer knows (a revoked peer whose
// flow is still on screen), so a glyph always draws. A selector like
// useRemoteDeviceApi, so a peer's status churn leaves the string alone.
export function useDeviceKind(deviceId: string): DeviceKind {
  const localKind = useLocalDeviceKind();
  const select = () =>
    remoteDeviceStore.getSnapshot().find((entry) => entry.deviceId === deviceId)
      ?.kind ?? MACHINE_FALLBACK_KIND;
  const remoteKind = useSyncExternalStore(
    remoteDeviceStore.subscribe,
    select,
    select,
  );
  return deviceId === localDeviceId ? localKind : remoteKind;
}

// The device's name for prose ("on Thinkpad", "Thinkpad:3000"). Falls
// back to a neutral phrase rather than the raw id, which means nothing
// to the reader.
export function useRemoteDeviceLabel(deviceId: string): string {
  return useRemoteDevice(deviceId)?.label ?? "the device";
}
