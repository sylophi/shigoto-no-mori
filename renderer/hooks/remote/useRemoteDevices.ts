// React binding over the remote device registry (v2 step 3, slice B).
// useSyncExternalStore subscribes a component to the registry's live
// snapshot, so device status (connecting, connected, backoff, blocked)
// renders without any polling or prop threading. Read side only: no
// settings UI and no scoped data live here, just the live snapshot the
// scoped surfaces resolve their device from.
import { useSyncExternalStore } from "react";
import { type RemoteDevice, remoteDeviceStore } from "@/lib/remote/devices";

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

// One registered device by id, live like the list. Undefined for the
// local device and for any id the registry doesn't know (a revoked peer,
// or a stale link into a device that left the account).
export function useRemoteDevice(deviceId: string): RemoteDevice | undefined {
  return useRemoteDevices().find((entry) => entry.deviceId === deviceId);
}

// The device's name for prose ("on Thinkpad", "Thinkpad:3000"). Falls
// back to a neutral phrase rather than the raw id, which means nothing
// to the reader.
export function useRemoteDeviceLabel(deviceId: string): string {
  return useRemoteDevice(deviceId)?.label ?? "the device";
}
