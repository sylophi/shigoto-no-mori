// The footer's page-nav cluster (Devices, Settings), shared by the
// desktop footer and the web sidebar's so the two shells' right edges
// cannot drift. Everything shell-specific arrives as props: the web
// has no updater, the desktop gates Devices on the account service.
import { MonitorSmartphone, Settings as SettingsIcon } from "lucide-react";
import { NavIconButton } from "./NavIconButton";

export function SidebarNavActions({
  devicesEnabled,
  updateReady = false,
}: {
  devicesEnabled: boolean;
  updateReady?: boolean;
}) {
  return (
    <>
      {devicesEnabled && (
        <NavIconButton to="/devices" tip="Devices" label="Devices">
          <MonitorSmartphone className="size-3.5" />
        </NavIconButton>
      )}
      <NavIconButton
        to="/settings"
        tip={updateReady ? "Settings — update available" : "Settings"}
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
