// The forest's device filter: which one device's worktrees the sidebar
// shows, or null for every device's. One value for both views, so a
// Tab flip keeps the narrowing, and a module store rather than sidebar
// state because the phone layout unmounts the forest between its tabs
// and a filter that reset on every tab change would have to be re-set
// every time. Session-only on purpose: a narrowed forest is a way of
// looking, not a preference, and a relaunch that hid three machines'
// work would read as work lost.
import {
  useDeviceRoster,
  type DeviceRosterEntry,
} from "@/components/shared/DeviceTabs";
import { createExternalStore, useExternalStore } from "@/store/externalStore";

const store = createExternalStore<string | null>(null);

export function setDeviceFilter(deviceId: string | null): void {
  if (store.get() !== deviceId) store.publish(deviceId);
}

export interface DeviceFilter {
  // The machines the forest can be narrowed to, in roster order: the
  // account's devices that host projects, this device counted. A
  // browser on the account hosts no forest, so it is not offered.
  choices: DeviceRosterEntry[];
  // The resolved pick, null for All. A pick naming a device no longer
  // offered (a peer revoked while picked) reads as All rather than as
  // an empty forest, and comes back with the peer.
  selected: DeviceRosterEntry | null;
}

// The choices and the pick together, so there is no wrong way to
// assemble them.
export function useDeviceFilter(): DeviceFilter {
  const picked = useExternalStore(store);
  const choices = useDeviceRoster();
  return {
    choices,
    selected: choices.find((entry) => entry.deviceId === picked) ?? null,
  };
}
