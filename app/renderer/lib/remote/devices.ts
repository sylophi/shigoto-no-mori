// The account's devices with their live status, an atom
// remoteDeviceSync rebuilds wholesale from the device list and the
// hub's status.
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { HostApi } from "@/lib/runtime/Api";
import type { RemoteDeviceStatus } from "@shigomori/ui/lib/deviceStatus.ts";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";

// A peer's api over the hub hop: its host modules (lib/runtime/Api.ts,
// peerApi).
export type RemoteDeviceApi = HostApi;

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
  // Set while the peer's session is up and it shares, or while it's
  // rostered with no session: a call while the direct plane's keeper
  // (shared/hub/directKeeper.ts) dials joins the dial, and
  // remoteDeviceSync refetches when the session lands. Host calls route
  // over the hub bridge onto the device link. Client-scoped calls reject
  // (lib/runtime/Api.ts, peerApi).
  api?: RemoteDeviceApi;
};

// The list: a stable reference between changes, a new one on every
// change, which is what a reader's selector compares.
export const remoteDevicesAtom = Atom.keepAlive(
  Atom.make<readonly RemoteDevice[]>([]),
);

// Shallow: every arm of the union is a flat object of primitives, so a
// new field is compared with no switch to update.
function sameStatus(a: RemoteDeviceStatus, b: RemoteDeviceStatus): boolean {
  const right = new Map<string, unknown>(Object.entries(b));
  const left = Object.entries(a);
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.get(key) === value)
  );
}

// The api is compared by reference on purpose: remoteDeviceSync builds
// one api per deviceId and keeps it, so a changed reference is a real
// change.
function sameDevice(a: RemoteDevice, b: RemoteDevice): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.label === b.label &&
    a.icon === b.icon &&
    a.appVersion === b.appVersion &&
    a.acceptsCommands === b.acceptsCommands &&
    a.api === b.api &&
    sameStatus(a.status, b.status)
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
