// Renderer registry of remote devices: the account's devices,
// deviceId-keyed. There is no per-device supervisor in the renderer.
// The one relay socket lives in main and a device's status DERIVES from
// the bridge (remoteDeviceSync.ts rebuilds the list wholesale on boot, on
// account changes and on every relay status change). The registry is
// the external store a React binding reads through useSyncExternalStore,
// so device status renders live without prop threading.
//
// This file is renderer-only: it reads window.api for the local device's
// facts. It is NOT the transport machinery (that is the relay bridge in
// main); it is the renderer's wiring around it, so it stays out of the
// headless proof.
import type { buildApi } from "@shared/ipc/client";
import type { ClientTransport } from "@shared/ipc/transport";
import type { SupervisorStatus } from "@shared/remote/supervisor";

// The per-device api buildApi returns. Same shape as window.api's
// contract methods, minus the bridge-only extras (deviceId, appVersion).
export type RemoteDeviceApi = ReturnType<typeof buildApi>;

export type RemoteDevice = {
  // The remote host's device id, from the account registry (always
  // set). This is what hostKeysFor scopes a remote device's query cache
  // under.
  deviceId: string;
  // Display label: the account device name.
  label: string;
  status: SupervisorStatus;
  // The remote host app's version, "" until the lazily opened peer
  // session confirms it.
  appVersion: string;
  // Present only while connected. Host calls route over the relay
  // bridge. Client-scoped calls reject (see rejectingClientTransport).
  api?: RemoteDeviceApi;
};

// True when a connected remote host's version differs from this client's.
// A nudge flag only: contracts are additive, so a skew never blocks the
// connection. Derived at read time rather than stored so it can never
// drift from device.appVersion: "" (not yet connected) is never a
// mismatch, since the version is unknown until the peer session confirms.
export function deviceVersionMismatch(device: RemoteDevice): boolean {
  return device.appVersion !== "" && device.appVersion !== localAppVersion;
}

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

// A local fact, read synchronously off the preload bridge exactly like
// the query-key device id, so deviceVersionMismatch can compare without
// threading it through.
const localAppVersion = window.api.appVersion;

const listeners = new Set<() => void>();
// Cached immutable snapshot for useSyncExternalStore: it must return a
// stable reference between changes, and a NEW reference on every change.
let snapshot: readonly RemoteDevice[] = [];

// Replace the store wholesale. Called by remoteDeviceSync.ts on boot,
// on account changes and on relay status changes.
export function setRemoteDevices(devices: readonly RemoteDevice[]): void {
  snapshot = [...devices];
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
