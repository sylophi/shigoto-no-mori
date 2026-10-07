import { type ReactNode, useState } from "react";
import { PAGE_BODY } from "@/components/shared/PageShell";
import { HOST_TABS, type HostTab, settingsPanelId } from "./settingsNav";

// Mounts its children on the first visit and keeps them mounted, so a
// form and its state survive a look elsewhere, while what is never
// visited costs nothing: a section's body (SettingsPanel), and a
// peer's form with its config read, a round trip to that machine,
// which waits for the first time its tab is picked.
export function MountOnceVisited({
  visited,
  children,
}: {
  visited: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(visited);
  if (visited && !shown) setShown(true);
  return shown ? children : null;
}

// One section's body: its own scroll region (so each section keeps its
// scroll position) around the width-capped settings column, mounted on
// its first visit and parked with `hidden` afterwards.
export function SettingsPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div id={id} hidden={!active} className={PAGE_BODY}>
      <MountOnceVisited visited={active}>
        <div className="flex flex-col gap-10">{children}</div>
      </MountOnceVisited>
    </div>
  );
}

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
    <SettingsPanel
      key={tab}
      id={settingsPanelId(tab, deviceId)}
      active={active === tab}
    >
      {sections[tab]}
    </SettingsPanel>
  ));
}
