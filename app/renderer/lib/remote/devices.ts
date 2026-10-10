// Renderer registry of remote devices: the account's devices,
// deviceId-keyed. There is no per-device supervisor in the renderer.
// The one hub socket lives in main and a device's status DERIVES from
// the bridge (remoteDeviceSync.ts rebuilds the list wholesale on boot, on
// account changes and on every hub status change). The registry is
// the external store a React binding reads through useSyncExternalStore,
// so device status renders live without prop threading.
//
// This file is renderer-only: it reads window.api for the local device's
// facts. It is NOT the transport machinery (that is the hub bridge in
// main); it is the renderer's wiring around it, so it stays out of the
// headless proof.
import { createExternalStore } from "@shigomori/ui/lib/externalStore.ts";
import type { RendererContractApi } from "@shared/ipc/client";
import type { RemoteDeviceStatus } from "@shigomori/ui/lib/deviceStatus.ts";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";

// The api over one device's transports. Same shape as window.api's
// contract methods, minus the bridge-only extras (deviceId, appVersion).
export type RemoteDeviceApi = RendererContractApi;

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
  // Present while the peer is online in the roster, whether or not a
  // direct session exists yet. Nothing here ever opens one: sessions
  // are supervised desired state owned by main's keeper
  // (shared/hub/directKeeper.ts), which dials every rostered peer
  // eagerly and redials forever. The api ships early anyway so a view
  // can stand ready through the dial window -- a call landing on the
  // in-flight dial joins it, one landing on no session rejects, and
  // the online-to-connected transition refetches it
  // (remoteDeviceSync.ts). Host calls route over the hub bridge onto
  // the direct wire. Client-scoped calls reject (lib/runtime/Api.ts,
  // peerApi).
  api?: RemoteDeviceApi;
};

// The snapshot store: a stable reference between changes, a NEW
// reference on every change, as useSyncExternalStore requires.
const store = createExternalStore<readonly RemoteDevice[]>([]);

// Field equality for the status union, so a rebuild that lands on the
// same phase (and the same per-phase detail) is recognized as no
// change. A generic shallow own-key compare instead of a per-phase
// switch, so a new phase or a new field on an existing one is compared
// rather than silently landing in a default-true arm. Every arm of the
// union is a flat object of primitives, which is what makes shallow
// exact here.
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

// Replace the store wholesale. Called by remoteDeviceSync.ts on boot,
// on account changes and on hub status changes. The rebuild arrives
// on every hub transition, most of which change nothing for most
// devices, so unchanged entries keep their previous object identity
// (a memoized row skips its re-render) and a fully identical rebuild
// bails without notifying at all. The dedupe is keyed by deviceId, not
// array index, so a roster reorder or an add/remove does not churn
// every row behind the shifted one. A pure reorder still notifies
// (positions changed) while keeping each row's identity.
export function setRemoteDevices(devices: readonly RemoteDevice[]): void {
  const snapshot = store.get();
  const previous = new Map(snapshot.map((device) => [device.deviceId, device]));
  let changed = devices.length !== snapshot.length;
  const next = devices.map((device, index) => {
    const old = previous.get(device.deviceId);
    const kept = old !== undefined && sameDevice(old, device) ? old : device;
    if (kept !== snapshot[index]) changed = true;
    return kept;
  });
  if (changed) store.publish(next);
}

// A device by id as the store has it now, for a caller outside React.
export function remoteDeviceById(deviceId: string): RemoteDevice | undefined {
  return store.get().find((device) => device.deviceId === deviceId);
}

// External store surface for useSyncExternalStore.
export const remoteDeviceStore = {
  subscribe: store.subscribe,
  getSnapshot: store.get,
};
