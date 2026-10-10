// The Settings page's sections, as plain data: their tab ids, their
// names and icons, and the panels their rows control. The selection
// and the pick of a machine live in settingsNav.ts.
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
  // A desktop window, whose machine is behind it (hasLocalHost).
  desktop: boolean,
): { client: SettingsSection[]; host: SettingsSection[] } {
  const section = (id: SettingsTab, icon: LucideIcon): SettingsSection => ({
    id,
    label: SECTION_LABELS[id],
    icon,
  });
  const client = [section(APPEARANCE_TAB, Palette)];
  if (desktop) client.push(section(LAUNCH_TAB, Rocket));
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
