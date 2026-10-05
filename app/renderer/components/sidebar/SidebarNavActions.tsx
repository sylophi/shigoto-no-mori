// The footer's page-nav cluster (Projects, Settings). Projects is the
// home page's grid (home/ProjectGrid.tsx), where a fresh window opens,
// and the footer is the one bar both sidebar views show. Devices and
// tidying are sections of Settings (SettingsSidebarNav). A hostless
// client's home is the Devices page, so its Devices button stands where
// Projects would: always there, since unconfigured or signed out the
// page itself explains the state (AccountSection) instead of the button
// hiding.
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
      {hasLocalHost ? (
        <NavIconButton to="/" tip="Projects" label="Projects">
          <LayoutGrid className="size-3.5" />
        </NavIconButton>
      ) : (
        <NavIconButton to="/account" tip="Devices" label="Devices">
          <MonitorSmartphone className="size-3.5" />
        </NavIconButton>
      )}
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
