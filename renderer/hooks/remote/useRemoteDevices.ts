// React binding over the remote device registry (v2 step 3, slice B).
// useSyncExternalStore subscribes a component to the registry's live
// snapshot, so device status (connecting, connected, backoff, blocked)
// renders without any polling or prop threading. No settings UI or
// forest view lives here: that is slice C. This is the reactive read
// side of the registry.
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
