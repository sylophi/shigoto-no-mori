import { useLocation, useNavigate } from "@tanstack/react-router";
import { Trees } from "lucide-react";
import { SectionHeading } from "@/components/ui/section-heading";
import { SidebarTakeover } from "@/components/sidebar/SidebarTakeover";
import { useGoBack } from "@/hooks/ui/useGoBack";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { StatusDot } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DeviceLead } from "@/components/shared/DeviceGlyph";
import { useLocalDevice } from "@/hooks/account/useAccount";
import { useHostDevices } from "@/hooks/remote/useRemoteDevices";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { hasLocalHost } from "@/lib/localHost";
import { cn } from "@/lib/utils";
import {
  isSolo,
  selectSettingsTab,
  settingsPanelId,
  settingsSections,
  useActiveSettingsTab,
  type SettingsSection,
} from "./settingsNav";
import { UpdateAllButton } from "./UpdateAllButton";

// The list in the sidebar for both pages it heads, Settings and Tidy.
// Switching sections pushes no history, so one step back always leaves.
export function SettingsTakeover() {
  const back = useGoBack();
  return (
    <SidebarTakeover back={{ label: "Back", onClick: back }}>
      <SettingsSidebarNav />
    </SidebarTakeover>
  );
}

// The Settings page's navigation, drawn in the app sidebar in place of
// the project tree while /settings is open (SidebarTakeover, which also
// draws the Back row above it). Three labelled groups:
// "Visual" holds what this window shows and nothing else ever sees;
// "Projects" holds what spans this machine's projects. "Devices" holds
// one row per machine on the account, this one first, each with the
// status dot the rest of the app draws for it. The split is the page's
// whole point, so the list shows it rather than a panel explaining it.
// The visual and device sections come from settingsSections, which the
// phone layout's chip row draws too.
//
// Projects leads to the Tidy page, which is a page of its own (its
// device tabs, its removals) rather than a form, so it keeps its route
// and draws this same list in the sidebar. Stepping between the two
// replaces the entry rather than pushing one, so one step back still
// leaves Settings, whichever of them it lands on.
function SettingsSidebarNav() {
  const navigate = useNavigate();
  const onTidy = useLocation({ select: (l) => l.pathname === TIDY_PATH });
  const devices = useHostDevices();
  const { activeTab } = useActiveSettingsTab(devices);
  const local = useLocalDevice();
  const solo = isSolo(devices);
  const updates = useStagedUpdates();
  const villageLife = useVillageLife();
  const sections = settingsSections(devices, local, updates, villageLife);
  const row = (section: SettingsSection) => (
    <NavRow
      key={section.id}
      section={section}
      active={!onTidy && activeTab === section.id}
      controls={settingsPanelId(section.id)}
      onSelect={() => {
        selectSettingsTab(section.id);
        if (onTidy) void navigate({ to: "/settings", replace: true });
      }}
    />
  );

  return (
    <nav aria-label="Settings sections" className="flex flex-col px-2 pb-2">
      <NavGroup label="Visual">{sections.visual.map(row)}</NavGroup>

      {hasLocalHost && (
        <NavGroup label="Projects">
          <NavRow
            section={TIDY_SECTION}
            active={onTidy}
            onSelect={() => void navigate({ to: TIDY_PATH, replace: true })}
          />
        </NavGroup>
      )}

      <NavGroup
        label={solo ? "Device" : "Devices"}
        action={<UpdateAllButton />}
      >
        {!hasLocalHost && devices.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground/70">
            No devices on this account yet.
          </p>
        )}
        {sections.devices.map(row)}
      </NavGroup>
    </nav>
  );
}

// A section's icon (a visual section's own, or a device's glyph), its
// presence dot and its name, the same in a sidebar row and in a phone
// chip. A device holding a staged update trails the
// sidebar Settings dot's own mark, so the dot that brought the visitor
// here points at the row it meant.
export function SectionLabel({ section }: { section: SettingsSection }) {
  const Icon = section.icon;
  return (
    <>
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
      {section.deviceIcon && (
        <DeviceLead icon={section.deviceIcon} tone={section.tone} />
      )}
      <span className="truncate">{section.label}</span>
      {section.update !== undefined && (
        <>
          <StatusDot tone="sky" className="ml-auto" />
          <span className="sr-only">update to v{section.update} available</span>
        </>
      )}
    </>
  );
}

// A labelled group of rows: the eyebrow is the scope, the page's own
// section heading at the sidebar's size so it reads as structure
// rather than as another row. An action for the whole group (the
// devices' Update all) trails the label.
function NavGroup({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2 px-2 pt-3 pb-1">
        <SectionHeading className="text-3xs text-muted-foreground/80">
          {label}
        </SectionHeading>
        {action}
      </div>
      {children}
    </div>
  );
}

const TIDY_PATH = "/tidy";

const TIDY_SECTION: SettingsSection = {
  id: "tidy",
  label: "Tidy the forest",
  icon: Trees,
};

// One row, with the sidebar rows' selection fill, so the list reads as
// the sidebar's rather than a foreign widget dropped in.
function NavRow({
  section,
  active,
  controls,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  // The settings panel the row shows. Tidy's row leads to a page.
  controls?: string;
  onSelect: () => void;
}) {
  return (
    <SimpleTooltip tip={section.tip}>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        aria-controls={controls}
        onClick={onSelect}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
          active
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <SectionLabel section={section} />
      </button>
    </SimpleTooltip>
  );
}
