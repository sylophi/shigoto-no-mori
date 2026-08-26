// Renderer registry of remote devices. The store holds BOTH kinds of
// entries: LAN devices (v2 step 3, url-keyed, each owning a reconnect
// supervisor) and relay devices (v2 step 4, deviceId-keyed, no renderer
// supervisor because the one relay socket lives in main and status
// derives from the bridge, see relayDevices.ts). One snapshot serves
// both so DeviceStatusDot and RemoteForest read them identically. The
// registry is the external store a React binding reads through
// useSyncExternalStore, so device status renders live without prop
// threading.
//
// This file is renderer-only: it reads window.api for the local device's
// facts and builds a per-device api. It is NOT the transport machinery
// (that is wsClientTransport, browser-global-only); it is the renderer's
// wiring around it, so it stays out of the headless proof.
import { buildApi } from "@shared/ipc/client";
import type { ClientTransport } from "@shared/ipc/transport";
import type { SupervisorStatus } from "@shared/remote/supervisor";
import { createSupervisor } from "@shared/remote/supervisor";
import type { RemoteDeviceEntry } from "@shared/schemas";

// The per-device api buildApi returns. Same shape as window.api's
// contract methods, minus the bridge-only extras (deviceId, appVersion).
export type RemoteDeviceApi = ReturnType<typeof buildApi>;

export type RemoteDevice = {
  // "lan" entries come from the config's remoteDevices list and are
  // url-keyed. "relay" entries come from the account's device registry
  // and are deviceId-keyed. The settings sections filter by kind, the
  // forest page does not care.
  kind: "lan" | "relay";
  // The remote host's device id: from its welcome for a LAN entry (""
  // until the first handshake), from the account registry for a relay
  // entry (always set). This is what hostKeysFor scopes a remote
  // device's query cache under.
  deviceId: string;
  // Display label: the config label (falling back to the url) for LAN,
  // the account device name for relay.
  label: string;
  // The ws:// url and LAN registry key. Empty for relay entries.
  url: string;
  status: SupervisorStatus;
  // The remote host app's version from its welcome, "" until connected
  // (for relay entries, until the lazily opened peer session confirms).
  appVersion: string;
  // Present only while connected. Host calls route over the socket or
  // the relay bridge. Client-scoped calls reject (see
  // rejectingClientTransport).
  api?: RemoteDeviceApi;
};

// True when a connected remote host's version differs from this client's.
// A nudge flag only: contracts are additive, so a skew never blocks the
// connection. Derived at read time rather than stored so it can never
// drift from device.appVersion: "" (not yet connected) is never a
// mismatch, since the version is unknown until the welcome lands.
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

// Local facts, read synchronously off the preload bridge exactly like
// the query-key device id. Module scope so an entry can build its hello
// params and compare versions without threading them through.
const localDeviceId = window.api.deviceId;
const localAppVersion = window.api.appVersion;

type Entry = {
  supervisor: ReturnType<typeof createSupervisor>;
  token: string;
  device: RemoteDevice;
};

const entries = new Map<string, Entry>();
// Relay entries, rebuilt wholesale by relayDevices.ts. No per-entry
// machinery here: their status derives from the relay bridge.
let relayDevices: readonly RemoteDevice[] = [];
const listeners = new Set<() => void>();
// Cached immutable snapshot for useSyncExternalStore: it must return a
// stable reference between changes, and a NEW reference on every change.
let snapshot: readonly RemoteDevice[] = [];

function rebuildSnapshot(): void {
  snapshot = [
    ...[...entries.values()].map((entry) => entry.device),
    ...relayDevices,
  ];
  for (const listener of listeners) listener();
}

// Replace the relay half of the store. Called by relayDevices.ts on
// boot, on account changes and on relay status changes.
export function setRelayDevices(devices: readonly RemoteDevice[]): void {
  relayDevices = [...devices];
  rebuildSnapshot();
}

// Replace an entry's device with a patched copy (never mutate in place,
// so referential-equality memoization sees the change) and refresh the
// snapshot.
function patchDevice(
  url: string,
  patch: (device: RemoteDevice) => RemoteDevice,
): void {
  const entry = entries.get(url);
  if (entry === undefined) return;
  entry.device = patch(entry.device);
  rebuildSnapshot();
}

function createEntry(config: RemoteDeviceEntry): void {
  const initialDevice: RemoteDevice = {
    kind: "lan",
    deviceId: "",
    label: config.label ?? config.url,
    url: config.url,
    status: { phase: "idle" },
    appVersion: "",
  };
  const supervisor = createSupervisor({
    params: {
      url: config.url,
      token: config.token,
      appVersion: localAppVersion,
      localDeviceId,
    },
    onStatus: (status) => patchDevice(config.url, (d) => ({ ...d, status })),
    onConnection: (connection) => {
      if (connection === null) {
        // Lost or torn down: drop the api so a stale, now-rejecting
        // transport is never handed out.
        patchDevice(config.url, (d) => ({ ...d, api: undefined }));
        return;
      }
      const api = buildApi({
        host: connection.transport,
        client: rejectingClientTransport,
      });
      patchDevice(config.url, (d) => ({
        ...d,
        deviceId: connection.remoteDeviceId,
        appVersion: connection.remoteAppVersion,
        api,
      }));
    },
  });
  entries.set(config.url, {
    supervisor,
    token: config.token,
    device: initialDevice,
  });
  supervisor.start();
}

// Reconcile the live registry against the wanted device list: connect
// entries that are new, drop entries that vanished, and restart an entry
// whose token changed (its supervisor may be blocked on the old token).
// A label-only change updates in place without touching the connection.
// The url is the entry identity this slice, so a duplicate url collapses
// to a single entry (last wins).
export function reconcileRemoteDevices(
  wantedList: readonly RemoteDeviceEntry[],
): void {
  const wanted = new Map<string, RemoteDeviceEntry>();
  for (const entry of wantedList) wanted.set(entry.url, entry);

  for (const [url, entry] of entries) {
    const next = wanted.get(url);
    if (next === undefined || next.token !== entry.token) {
      entry.supervisor.stop();
      entries.delete(url);
    }
  }

  for (const [url, config] of wanted) {
    const existing = entries.get(url);
    if (existing === undefined) {
      createEntry(config);
      continue;
    }
    const label = config.label ?? config.url;
    if (existing.device.label !== label) {
      existing.device = { ...existing.device, label };
    }
  }

  rebuildSnapshot();
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
