// The footer's page-nav cluster (Projects, Devices, Settings). Projects
// is the home page's grid (home/ProjectGrid.tsx), where a fresh window
// opens, and the footer is the one bar both sidebar views show. A
// hostless client's home is the Devices page, so it has no Projects
// button. Devices is always reachable: unconfigured or signed out, the
// page itself explains the state (AccountSection) instead of the button
// hiding. Tidying is a section of Settings (SettingsSidebarNav).
// Settings wears a dot while any device's section there holds an update
// this window could install: the local machine's, or a peer's (the only
// kind a hostless client can have).
import {
  LayoutGrid,
  MonitorSmartphone,
  Settings as SettingsIcon,
} from "lucide-react";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { hasLocalHost } from "@/lib/localHost";
import { NavIconButton } from "./NavIconButton";

export function SidebarNavActions() {
  const updateReady = Object.keys(useStagedUpdates()).length > 0;
  return (
    <>
      {hasLocalHost && (
        <NavIconButton to="/" tip="Projects" label="Projects">
          <LayoutGrid className="size-3.5" />
        </NavIconButton>
      )}
      <NavIconButton to="/devices" tip="Devices" label="Devices">
        <MonitorSmartphone className="size-3.5" />
      </NavIconButton>
      <NavIconButton
        to="/settings"
        tip={updateReady ? "Settings (update available)" : "Settings"}
        label={updateReady ? "Settings (update available)" : "Settings"}
      >
        <SettingsIcon className="size-3.5" />
        {updateReady && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 ring-2 ring-card"
          />
        )}
      </NavIconButton>
    </>
  );
}
