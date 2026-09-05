// The footer's page-nav cluster (Devices, Settings). Devices is always
// reachable: unconfigured or signed out, the page itself explains the
// state (AccountSection) instead of the button hiding. A hostless
// client has no updater to flag.
import { MonitorSmartphone, Settings as SettingsIcon } from "lucide-react";
import { NavIconButton } from "./NavIconButton";

export function SidebarNavActions({
  updateReady = false,
}: {
  updateReady?: boolean;
}) {
  return (
    <>
      <NavIconButton to="/devices" tip="Devices" label="Devices">
        <MonitorSmartphone className="size-3.5" />
      </NavIconButton>
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
