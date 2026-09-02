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
import type { buildApi } from "@shared/ipc/client";
import type { ClientTransport } from "@shared/ipc/transport";
import type { SupervisorStatus } from "@shared/remote/supervisor";

// The per-device api buildApi returns. Same shape as window.api's
// contract methods, minus the bridge-only extras (deviceId, appVersion).
export type RemoteDeviceApi = ReturnType<typeof buildApi>;

// A remote device's derived status: the supervisor vocabulary the
// hub socket reports, plus the one renderer-local phase the direct
// data plane needs. "online" means the peer is in the hub roster but
// no direct session is established (not dialed yet, or the dial
// failed), so it is NOT rendered as connected (v2 step 10, slice C:
// data is direct or nothing, and a roster fact must not claim a data
// wire).
export type RemoteDeviceStatus = SupervisorStatus | { phase: "online" };

export type RemoteDevice = {
  // The remote host's device id, from the account registry (always
  // set). This is what hostKeysFor scopes a remote device's query cache
  // under.
  deviceId: string;
  // Display label: the account device name.
  label: string;
  status: RemoteDeviceStatus;
  // The remote host app's version, "" until the direct session's
  // welcome confirms it.
  appVersion: string;
  // Present while the peer is online in the roster, whether or not a
  // direct session exists yet. Nothing here ever opens one: sessions
  // are supervised desired state owned by main's keeper
  // (shared/hub/directKeeper.ts), which dials every rostered peer
  // eagerly and redials forever. The api ships early anyway so a view
  // can stand ready through the dial window -- a call landing on the
  // in-flight dial joins it, one landing on no session rejects, and
  // the online-to-connected transition refetches it
  // (remoteDeviceSync.ts). Host calls route over the hub bridge onto
  // the direct wire. Client-scoped calls reject (see
  // rejectingClientTransport).
  api?: RemoteDeviceApi;
};

// Client-scoped calls only make sense for the local machine, so a remote
// device's client transport rejects them outright rather than sending
// them over a wire that has no client scope.
const REMOTE_CLIENT_SCOPE_MESSAGE =
  "client-scoped call is not available for a remote device";

export const rejectingClientTransport: ClientTransport = {
  // Reject rather than throw synchronously so a client-scoped call on a
  // remote device fails through the same promise path as any other
  // transport error, matching the ClientTransport contract.
  invoke() {
    return Promise.reject(new Error(REMOTE_CLIENT_SCOPE_MESSAGE));
  },
  // Nothing to subscribe to over a scope that does not exist here. Log
  // so a stray subscription is visible, and hand back a no-op unsubscribe
  // so the caller's cleanup path stays uniform.
  subscribe() {
    console.warn(`[remote] ${REMOTE_CLIENT_SCOPE_MESSAGE}`);
    return () => {};
  },
};

const listeners = new Set<() => void>();
// Cached immutable snapshot for useSyncExternalStore: it must return a
// stable reference between changes, and a NEW reference on every change.
let snapshot: readonly RemoteDevice[] = [];

// Field equality for the status union, so a rebuild that lands on the
// same phase (and the same per-phase detail) is recognized as no
// change. A generic shallow own-key compare instead of a per-phase
// switch, so a new phase or a new field on an existing one is compared
// rather than silently landing in a default-true arm. Every arm of the
// union is a flat object of primitives, which is what makes shallow
// exact here.
function sameStatus(a: RemoteDeviceStatus, b: RemoteDeviceStatus): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

// The api is compared by reference on purpose: remoteDeviceSync builds
// one api per deviceId and keeps it, so a changed reference is a real
// change.
function sameDevice(a: RemoteDevice, b: RemoteDevice): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.label === b.label &&
    a.appVersion === b.appVersion &&
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
  const previous = new Map(snapshot.map((device) => [device.deviceId, device]));
  let changed = devices.length !== snapshot.length;
  const next = devices.map((device, index) => {
    const old = previous.get(device.deviceId);
    const kept = old !== undefined && sameDevice(old, device) ? old : device;
    if (kept !== snapshot[index]) changed = true;
    return kept;
  });
  if (!changed) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

// External store surface for useSyncExternalStore.
export const remoteDeviceStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): readonly RemoteDevice[] {
    return snapshot;
  },
};
