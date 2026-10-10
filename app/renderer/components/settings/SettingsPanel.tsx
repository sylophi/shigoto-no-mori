import type { ReactNode } from "react";
import { SettingsPanelView } from "./SettingsPanelView";
import { HOST_TABS, type HostTab, settingsPanelId } from "./settingsSections";

// What a device shows on each host section.
export type HostSections = Record<HostTab, ReactNode>;

// The same node on every host section (a note standing in for them all).
export function onEveryHostTab(node: ReactNode): HostSections {
  return { general: node, worktrees: node, integrations: node };
}

// One device's host sections, a panel each. The device's form lives
// above them (one per device, spanning all three sections), so an edit
// on Worktrees is still there after a look at Integrations. `active` is
// the host section showing while this device is picked, undefined
// while it isn't (or while a client section shows).
export function HostPanels({
  deviceId,
  active,
  sections,
}: {
  deviceId: string;
  active: HostTab | undefined;
  sections: HostSections;
}) {
  return HOST_TABS.map((tab) => (
    <SettingsPanelView
      key={tab}
      id={settingsPanelId(tab, deviceId)}
      active={active === tab}
    >
      {sections[tab]}
    </SettingsPanelView>
  ));
}
