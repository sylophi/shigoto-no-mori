import { useState } from "react";
import type { RemoteDevice, RemoteDeviceApi } from "@/lib/remote/devices";

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
// and undefined again once the device itself is gone from the
// registry (removed from the account, or the account left): a blip
// keeps the device with no api, a departure drops the device, and
// only the first is worth riding out. Without this the kept api would
// outlive the account it was built under, and a device of a later
// account with the same id would open on the old one's cache.
export function useLastGoodApi(
  device: RemoteDevice | undefined,
): RemoteDeviceApi | undefined {
  const [api, setApi] = useState(device?.api);
  if (device === undefined) {
    if (api !== undefined) setApi(undefined);
    return undefined;
  }
  if (device.api !== undefined && device.api !== api) setApi(device.api);
  return api;
}
