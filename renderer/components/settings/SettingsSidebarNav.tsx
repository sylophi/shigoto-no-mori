import { Palette, Rocket } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { WORKTREE_ROW_BUTTON } from "@/components/sidebar/WorktreeRow";
import { BackButton } from "@/components/ui/back-button";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";
import {
  APPEARANCE_TAB,
  deviceTab,
  LAUNCH_TAB,
  LOCAL_DEVICE_TAB,
  selectSettingsTab,
  settingsPanelId,
  useActiveSettingsTab,
} from "./settingsNav";

// The Settings page's navigation, rendered by the app sidebar in place
// of the project tree while /settings is open. Two labelled groups:
// "Visual" holds what this window shows and nothing else ever sees;
// "Devices" holds one row per machine on the account, this one first,
// each with the status dot the rest of the app draws for it. The split
// is the page's whole point, so the list shows it rather than a panel
// explaining it.
export function SettingsSidebarNav() {
  const navigate = useNavigate();
  const devices = useRemoteDevices();
  const { activeTab } = useActiveSettingsTab(devices);
  const localName = useLocalDeviceName();
  // One machine means no choice to offer, so the group reads as this
  // device's settings rather than a roster of one, and the presence
  // dot (a fact about peers) stays off.
  const solo = devices.length === 0;

  return (
    <nav aria-label="Settings sections" className="flex flex-col px-2 pb-2">
      {/* The tree is gone while this list is up, so the way back to the
          forest is the first row. "/" lands on the first worktree, the
          same place a fresh window opens. */}
      <div className="mb-1 pl-2">
        <BackButton
          label="Projects"
          onClick={() => void navigate({ to: "/" })}
        />
      </div>

      <NavGroup label="Visual">
        <NavRow id={APPEARANCE_TAB} active={activeTab === APPEARANCE_TAB}>
          <Palette aria-hidden className="size-3.5 shrink-0" />
          Appearance
        </NavRow>
        <NavRow id={LAUNCH_TAB} active={activeTab === LAUNCH_TAB}>
          <Rocket aria-hidden className="size-3.5 shrink-0" />
          Launch tools
        </NavRow>
      </NavGroup>

      <NavGroup label={solo ? "Device" : "Devices"}>
        <NavRow
          id={LOCAL_DEVICE_TAB}
          active={activeTab === LOCAL_DEVICE_TAB}
          title="This device: the machine this window runs on"
        >
          {!solo && <StatusDot tone="emerald" />}
          <span className="truncate">{localName}</span>
        </NavRow>
        {devices.map((device) => {
          const { tone, label } = deviceStatusView(device.status);
          const id = deviceTab(device.deviceId);
          return (
            <NavRow
              key={device.deviceId}
              id={id}
              active={activeTab === id}
              title={`${device.label}: ${label}`}
            >
              <StatusDot tone={tone} />
              <span className="truncate">{device.label}</span>
            </NavRow>
          );
        })}
      </NavGroup>
    </nav>
  );
}

// A labelled group of rows: the eyebrow is the scope, the page's own
// section heading at the sidebar's size so it reads as structure
// rather than as another row.
function NavGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <SectionHeading className="px-2 pt-3 pb-1 text-[10px] text-muted-foreground/80">
        {label}
      </SectionHeading>
      {children}
    </div>
  );
}

// One row, on the worktree rows' own class and selection fill, so the
// list reads as the sidebar's rather than a foreign widget dropped in.
function NavRow({
  id,
  active,
  title,
  children,
}: {
  id: string;
  active: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-controls={settingsPanelId(id)}
      title={title}
      onClick={() => selectSettingsTab(id)}
      className={cn(
        WORKTREE_ROW_BUTTON,
        "min-w-0 py-1.5",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
