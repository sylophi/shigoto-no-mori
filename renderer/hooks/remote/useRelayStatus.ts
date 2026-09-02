import { useSyncExternalStore } from "react";
import type { RelayStatus, TunnelState } from "@shared/ipc/modules/relay";

// The relay bridge's live status snapshot as a module-scope store with
// ONE writer: remoteDeviceSync (renderer/lib/remote/remoteDeviceSync.ts)
// already holds the boot-scope onStatusChanged subscription and the
// initial fetch-with-retry, and publishes every snapshot it sees here.
// The hooks below are thin useSyncExternalStore bindings over that
// store, no subscription, no started latch and no initial-fetch race of
// their own, so every consumer (the tunnel marker on the devices
// section, the web devices page's own-row status) reads the same value.
// Null until the first snapshot lands.
let snapshot: RelayStatus | null = null;
const listeners = new Set<() => void>();

// The single writer's entry point. Not for components.
export function publishRelayStatus(status: RelayStatus): void {
  snapshot = status;
  for (const listener of listeners) listener();
}

// Seeds the store with a FETCHED snapshot. A broadcast that raced the
// fetch is newer and wins, so a seed lands only while nothing was
// published yet.
export function seedRelayStatus(status: RelayStatus): void {
  if (snapshot === null) publishRelayStatus(status);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): RelayStatus | null => snapshot;

export function useRelayStatus(): RelayStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Derived primitive for consumers that only care about THIS device's
// tunnel endpoint (the marker and the note on the this-device row):
// useSyncExternalStore re-renders only when the selected value changes,
// so roster and socket transitions leave those components alone.
// Undefined until the first snapshot lands, and on a platform with no
// host half (the web bridge runs no cloudflared).
const getTunnelState = (): TunnelState | undefined => snapshot?.tunnel;

export function useTunnelState(): TunnelState | undefined {
  return useSyncExternalStore(subscribe, getTunnelState, getTunnelState);
}
