import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import {
  APPEARANCE_TAB,
  GENERAL_TAB,
  isHostTab,
  LAUNCH_TAB,
  settingsPanelId,
  type SettingsTab,
  VISITORS_TAB,
} from "./settingsSections";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { hasLocalHost } from "@/lib/localHost";
import {
  pickHostDevice,
  useDeviceRoster,
  useHostDevicePick,
} from "@/components/shared/DeviceTabs";

// The Settings page's navigation lives in the app sidebar (the project
// tree gives way to the section list while /settings is open), while
// the forms live in the main pane. This store is the seam between the
// two: the sidebar writes which section is selected and the form reads
// it. Module state on purpose: the selection is a navigation nicety
// for this window's lifetime (coming back to Settings lands on the
// same section), not a preference worth persisting. Which machine a
// host section shows is the pick it shares with Tidy
// (useHostDevicePick).

const selectedTab = createExternalStore<string>(APPEARANCE_TAB);

export function selectSettingsTab(tab: string): void {
  if (selectedTab.get() === tab) return;
  selectedTab.publish(tab);
}

// The raw selection. The resolved tab is the hook below.
function useSelectedSettingsTab(): string {
  return useExternalStore(selectedTab);
}

// A section this window no longer offers (Visitors once Village life
// is off) falls back to the General section. A hostless client (the
// web shell) has no device of its own, so it falls back to Appearance.
const FALLBACK_TAB = hasLocalHost ? GENERAL_TAB : APPEARANCE_TAB;

// The selection, minus a section this window doesn't offer (Visitors
// with Village life off), for the sidebar's highlight and the form's
// panel alike.
export function useActiveSettingsTab(): SettingsTab {
  const selected = useSelectedSettingsTab();
  const villageLife = useVillageLife();
  if (selected === APPEARANCE_TAB || isHostTab(selected)) return selected;
  if (selected === VISITORS_TAB && villageLife) return selected;
  if (hasLocalHost && selected === LAUNCH_TAB) return selected;
  return FALLBACK_TAB;
}

// The panel a section's row or chip controls, for its aria-controls: a
// host section's belongs to the picked device, and there is none while
// no device is on offer.
export function useSettingsPanelControls(): (
  tab: string,
) => string | undefined {
  const picked = useHostDevicePick(useDeviceRoster());
  return (tab) =>
    !isHostTab(tab)
      ? settingsPanelId(tab)
      : picked && settingsPanelId(tab, picked.deviceId);
}

// The sidebar's "update available" dot leads to Settings, and the
// button it promises lives on the General section of the device holding
// the update, so the first visit while a given update is staged lands
// there. Once per device and version: after that the visitor's own
// choice stands.
const noticedUpdates = new Set<string>();

// `updates` is useStagedUpdates' answer, this device first. The first
// one not yet noticed wins, so a peer's update staged behind an
// already-seen local one still gets its visit.
export function landOnStagedUpdate(
  updates: Readonly<Record<string, string>>,
): void {
  for (const [deviceId, version] of Object.entries(updates)) {
    const update = `${deviceId}@${version}`;
    if (noticedUpdates.has(update)) continue;
    noticedUpdates.add(update);
    selectSettingsTab(GENERAL_TAB);
    pickHostDevice(deviceId);
    return;
  }
}
