import { useSyncExternalStore } from "react";
import { createExternalStore, useExternalStore } from "@/store/externalStore";
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

const { subscribe } = store;

export function useHubStatus(): HubStatus | null {
  return useExternalStore(store);
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

// THIS device's blocked socket, or null while it is anything else (the
// account sync's sign-out trigger, the registry's blocked banner).
// Every snapshot arrives as a fresh object, so the selector hands back
// the previous value while the two fields it reads are unchanged, which
// is what keeps roster and presence traffic from re-rendering the
// subscribers.
type HubBlock = Extract<HubStatus["socket"], { phase: "blocked" }>;
let lastBlock: HubBlock | null = null;
const getBlock = (): HubBlock | null => {
  const socket = store.get()?.socket;
  const next = socket?.phase === "blocked" ? socket : null;
  if (
    next !== null &&
    lastBlock !== null &&
    next.reason === lastBlock.reason &&
    next.message === lastBlock.message
  ) {
    return lastBlock;
  }
  lastBlock = next;
  return next;
};

export function useHubBlock(): HubBlock | null {
  return useSyncExternalStore(subscribe, getBlock, getBlock);
}
