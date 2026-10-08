import { createExternalStore, useExternalStore } from "@/store/externalStore";
import {
  BookHeart,
  CircleUserRound,
  GitBranch,
  Palette,
  Plug,
  Rocket,
  SlidersHorizontal,
  Trees,
  type LucideIcon,
} from "lucide-react";
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

export const APPEARANCE_TAB = "appearance";
export const LAUNCH_TAB = "launch";
// Who has visited (components/visitors), offered while this window's
// Village life shows.
export const VISITORS_TAB = "visitors";

// The host sections: what is stored on a machine, one form per
// machine, picked with the device tab bar in the page header.
export const GENERAL_TAB = "general";
const WORKTREES_TAB = "worktrees";
const INTEGRATIONS_TAB = "integrations";
export const HOST_TABS = [
  GENERAL_TAB,
  WORKTREES_TAB,
  INTEGRATIONS_TAB,
] as const;
export type HostTab = (typeof HOST_TABS)[number];

export function isHostTab(tab: string): tab is HostTab {
  return (HOST_TABS as readonly string[]).includes(tab);
}

export type SettingsTab =
  | typeof APPEARANCE_TAB
  | typeof LAUNCH_TAB
  | typeof VISITORS_TAB
  | HostTab;

// The panel element a sidebar row controls, so the aria wiring on both
// sides comes from one place. A host section has one panel per device.
export function settingsPanelId(tab: string, deviceId?: string): string {
  const id = deviceId === undefined ? tab : `${tab}:${deviceId}`;
  return `settings-panel-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

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

// One section of the page as a list draws it: its tab id, its label
// and its icon. The General section flags a staged update this window
// could install on any device, which its tab bar then places.
export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  update?: boolean;
}

// The page's sections in order, for whichever surface lists them: the
// sidebar's nav on a wide viewport (SettingsSidebarNav), the chip row
// under the header in the phone layout (SettingsSectionChips). Two
// groups, since the split is the page's whole point: "client" is what
// this window shows, "host" is what each machine stores, edited one
// machine at a time. A hostless client has no machine behind the
// window, so its client group is Appearance alone. Visitors joins the
// client group while Village life shows, which it never does on a
// hostless client.
export function settingsSections(
  // Whether any device holds a staged update this window could install
  // (useStagedUpdates' answer is non-empty).
  update: boolean,
  // useVillageLife's answer.
  villageLife: boolean,
): { client: SettingsSection[]; host: SettingsSection[] } {
  const section = (id: SettingsTab, icon: LucideIcon): SettingsSection => ({
    id,
    label: SECTION_LABELS[id],
    icon,
  });
  const client = [section(APPEARANCE_TAB, Palette)];
  if (hasLocalHost) client.push(section(LAUNCH_TAB, Rocket));
  if (villageLife) client.push(section(VISITORS_TAB, BookHeart));
  const host = [
    { ...section(GENERAL_TAB, SlidersHorizontal), update },
    section(WORKTREES_TAB, GitBranch),
    section(INTEGRATIONS_TAB, Plug),
  ];
  return { client, host };
}

// Each section's name, for its row in the list and its page title.
export const SECTION_LABELS: Readonly<Record<SettingsTab, string>> = {
  [APPEARANCE_TAB]: "Appearance",
  [LAUNCH_TAB]: "Launch tools",
  [VISITORS_TAB]: "Visitors",
  [GENERAL_TAB]: "General",
  [WORKTREES_TAB]: "Worktrees",
  [INTEGRATIONS_TAB]: "Integrations",
};

// The pages beside Settings that its list leads to (SettingsPages).
export const TIDY_SECTION: SettingsSection = {
  id: "tidy",
  label: "Tidy the forest",
  icon: Trees,
};

export const ACCOUNT_SECTION: SettingsSection = {
  id: "account",
  label: "Account",
  icon: CircleUserRound,
};
