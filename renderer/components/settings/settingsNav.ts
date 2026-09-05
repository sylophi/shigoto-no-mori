import { createExternalStore } from "@/store/externalStore";
import { useSyncExternalStore } from "react";
import type { RemoteDevice } from "@/lib/remote/devices";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";

// The Settings page's navigation lives in the app sidebar (the project
// tree gives way to the section list while /settings is open), while
// the forms live in the main pane. This store is the seam between the
// two: the sidebar writes which section is selected and the form reads
// it. Module state on purpose: the selection is a navigation nicety
// for this window's lifetime (coming back to Settings lands on the
// same device), not a preference worth persisting.

export const APPEARANCE_TAB = "appearance";
export const LAUNCH_TAB = "launch";

export function deviceTab(deviceId: string): string {
  return `device:${deviceId}`;
}

export const LOCAL_DEVICE_TAB = deviceTab(localDeviceId);

// The panel element a sidebar row controls, so the aria wiring on both
// sides comes from one place.
export function settingsPanelId(tab: string): string {
  return `settings-panel-${tab.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

const selectedTab = createExternalStore<string>(APPEARANCE_TAB);

export function selectSettingsTab(tab: string): void {
  if (selectedTab.get() === tab) return;
  selectedTab.publish(tab);
}

// The raw selection, for the shell that reacts to a pick (the narrow
// layout's sheet closes on one). The resolved tab is the hook below.
export function useSelectedSettingsTab(): string {
  return useSyncExternalStore(
    selectedTab.subscribe,
    selectedTab.get,
    selectedTab.get,
  );
}

// Launch tools and this device describe the machine the window runs
// on. A hostless client (the web shell) has no such machine, so it
// offers neither and falls back to Appearance where the desktop falls
// back to this device.
const FALLBACK_TAB = hasLocalHost ? LOCAL_DEVICE_TAB : APPEARANCE_TAB;

// One machine on the account means no roster to place it in: the
// Devices group reads as this device's settings rather than a list of
// one, and the presence dot (a fact about peers) stays off. Never true
// on a hostless client, whose roster is peers only.
export function isSolo(devices: readonly RemoteDevice[]): boolean {
  return hasLocalHost && devices.length === 0;
}

// The selection resolved against the live device list, for the
// sidebar's highlight and the form's panel alike. A remembered peer
// that has left the registry (revoked, or the account signed out)
// falls back to this device rather than stranding an empty selection;
// a peer that is merely not rostered YET keeps its selection pending
// and takes over the moment it appears.
export function useActiveSettingsTab(devices: readonly RemoteDevice[]): {
  activeTab: string;
  // The peer the active tab names, undefined for every other tab.
  peer: RemoteDevice | undefined;
} {
  const selected = useSelectedSettingsTab();
  const peer = devices.find(
    (device) => deviceTab(device.deviceId) === selected,
  );
  const known =
    selected === APPEARANCE_TAB ||
    (hasLocalHost &&
      (selected === LAUNCH_TAB || selected === LOCAL_DEVICE_TAB)) ||
    peer !== undefined;
  return { activeTab: known ? selected : FALLBACK_TAB, peer };
}

// The sidebar's "update available" dot leads here, and the button it
// promises lives on this device's section, so the first visit while a
// given update is staged lands there. Once per version: after that
// the visitor's own choice stands.
let noticedUpdateVersion: string | null = null;

export function landOnStagedUpdate(version: string): void {
  if (noticedUpdateVersion === version) return;
  noticedUpdateVersion = version;
  selectSettingsTab(LOCAL_DEVICE_TAB);
}
