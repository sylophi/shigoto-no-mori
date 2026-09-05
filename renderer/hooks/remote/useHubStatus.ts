import { useSyncExternalStore } from "react";
import { createExternalStore } from "@/store/externalStore";
import type { HubStatus, TunnelState } from "@shared/ipc/modules/hub";

// The hub bridge's live status snapshot as a module-scope store with
// ONE writer: remoteDeviceSync (renderer/lib/remote/remoteDeviceSync.ts)
// already holds the boot-scope onStatusChanged subscription and the
// initial fetch-with-retry, and publishes every snapshot it sees here.
// The hooks below are thin useSyncExternalStore bindings over that
// store, no subscription, no started latch and no initial-fetch race of
// their own, so every consumer (the tunnel marker on the devices
// section, the web devices page's own-row status) reads the same value.
// Null until the first snapshot lands.
const store = createExternalStore<HubStatus | null>(null);

// The single writer's entry point. Not for components.
export function publishHubStatus(status: HubStatus): void {
  store.publish(status);
}

// Seeds the store with a FETCHED snapshot. A broadcast that raced the
// fetch is newer and wins, so a seed lands only while nothing was
// published yet.
export function seedHubStatus(status: HubStatus): boolean {
  if (store.get() !== null) return false;
  store.publish(status);
  return true;
}

const { subscribe, get: getSnapshot } = store;

export function useHubStatus(): HubStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Derived primitive for consumers that only care about THIS device's
// tunnel endpoint (the marker and the note on the this-device row):
// useSyncExternalStore re-renders only when the selected value changes,
// so roster and socket transitions leave those components alone.
// Undefined until the first snapshot lands, and on a platform with no
// host half (the web bridge runs no cloudflared).
const getTunnelState = (): TunnelState | undefined => store.get()?.tunnel;

export function useTunnelState(): TunnelState | undefined {
  return useSyncExternalStore(subscribe, getTunnelState, getTunnelState);
}
