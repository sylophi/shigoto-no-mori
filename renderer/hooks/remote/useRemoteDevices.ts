// React binding over the remote device registry (v2 step 3, slice B).
// useSyncExternalStore subscribes a component to the registry's live
// snapshot, so device status (connecting, connected, backoff, blocked)
// renders without any polling or prop threading. No settings UI or
// forest view lives here: that is slice C. This is the reactive read
// side of the registry plus a lookup for a connected device's api.
import { useSyncExternalStore } from "react";
import {
  getRemoteDeviceApi,
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

// A single device by its registry key (its url this slice), or undefined
// when no such entry exists. Reactive: derived from the live list.
export function useRemoteDevice(url: string): RemoteDevice | undefined {
  const devices = useRemoteDevices();
  return devices.find((device) => device.url === url);
}

// A connected device's api by its registry key, or undefined when the
// device is absent or not currently connected. Reactive, so a component
// re-renders the moment the connection lands or drops.
export function useRemoteDeviceApi(url: string): RemoteDeviceApi | undefined {
  return useRemoteDevice(url)?.api;
}

// Non-reactive lookup for imperative call sites (event handlers, effects)
// that just need the current api without subscribing.
export { getRemoteDeviceApi };
