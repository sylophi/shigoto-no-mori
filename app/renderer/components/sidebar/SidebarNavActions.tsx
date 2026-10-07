// The footer's page-nav cluster (Live, Projects, Settings). Projects is the
// home page's grid (home/ProjectGrid.tsx), where a fresh window opens,
// and the footer is the one bar both sidebar views show. Devices and
// tidying are sections of Settings (SettingsSidebarNav). A hostless
// client's home is the Devices page, so its Devices button stands where
// Projects would: always there, since unconfigured or signed out the
// page itself explains the state (AccountSection) instead of the button
// hiding.
// Live wears a dot while anything runs: a script on any device, a
// forward this machine holds, a mirror.
// Settings wears a dot while any device holds an update this window
// could install from its General section there: the local machine's,
// or a peer's (the only kind a hostless client can have).
import {
  LayoutGrid,
  MonitorSmartphone,
  Radio,
  Settings as SettingsIcon,
} from "lucide-react";
import { useLiveCount } from "@/hooks/live/useLiveActivity";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { hasLocalHost } from "@/lib/localHost";
import { NavIconButton } from "./NavIconButton";

export function SidebarNavActions() {
  const updateReady = Object.keys(useStagedUpdates()).length > 0;
  const live = useLiveCount();
  const liveTip = live > 0 ? `Live (${live} running)` : "Live";
  return (
    <>
      <NavIconButton to="/live" tip={liveTip} label={liveTip}>
        <Radio className="size-3.5" />
        {live > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500 ring-2 ring-card"
          />
        )}
      </NavIconButton>
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
