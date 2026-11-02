import { useState } from "react";
import type { HostApi } from "@/lib/runtime/Api";
import { type Device, liveApi } from "@/lib/remote/devices";

// The api of the last session the registry handed over for a device.
// A hub or session blip drops device.api while the keeper redials, and
// the api object is one per device for the window's lifetime
// (remoteDeviceSync), so keeping the last one mounted keeps whatever
// sits under it (a seeded form and its unsaved edits, a scrolled diff,
// a console's scrollback) alive across the blip instead of unmounting
// it with a note. Requests on the kept api do not hang: the hub bridge
// hard-rejects them with "no direct connection", so the queries
// beneath fail honestly, and the device's cache is refetched on the
// next session landing. undefined until the device has ever had one,
// and again once the device is gone from the registry: a blip keeps
// the device with no api, a departure drops the device, and only the
// first is worth riding out. Kept with the device it belongs to: a
// caller that switches devices (the shared device panel) gets the new
// device's api or none, never the last device's.
export function useLastGoodApi(
  device: Device | undefined,
): HostApi | undefined {
  const api = device === undefined ? undefined : liveApi(device);
  const [kept, setKept] = useState(
    device === undefined ? undefined : { deviceId: device.deviceId, api },
  );
  if (device === undefined) {
    if (kept !== undefined) setKept(undefined);
    return undefined;
  }
  if (kept?.deviceId !== device.deviceId) {
    setKept({ deviceId: device.deviceId, api });
    return api;
  }
  if (api !== undefined && api !== kept.api) {
    setKept({ deviceId: device.deviceId, api });
  }
  return api ?? kept.api;
}
