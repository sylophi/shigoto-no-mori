import { useNavigate } from "@tanstack/react-router";
import { WORKTREE_ROW_BUTTON } from "@/components/sidebar/WorktreeRow";
import { BackButton } from "@/components/ui/back-button";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
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

// The Settings page's navigation, rendered by the app sidebar in place
// of the project tree while /settings is open. Two labelled groups:
// "Visual" holds what this window shows and nothing else ever sees;
// "Devices" holds one row per machine on the account, this one first,
// each with the status dot the rest of the app draws for it. The split
// is the page's whole point, so the list shows it rather than a panel
// explaining it. The sections themselves come from settingsSections,
// which the phone layout's chip row draws too.
export function SettingsSidebarNav() {
  const navigate = useNavigate();
  const devices = useRemoteDevices();
  const { activeTab } = useActiveSettingsTab(devices);
  const localName = useLocalDeviceName();
  const solo = isSolo(devices);
  const sections = settingsSections(devices, localName);

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
        {sections.visual.map((section) => (
          <NavRow
            key={section.id}
            section={section}
            active={activeTab === section.id}
          />
        ))}
      </NavGroup>

      <NavGroup label={solo ? "Device" : "Devices"}>
        {!hasLocalHost && devices.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground/70">
            No devices on this account yet.
          </p>
        )}
        {sections.devices.map((section) => (
          <NavRow
            key={section.id}
            section={section}
            active={activeTab === section.id}
          />
        ))}
      </NavGroup>
    </nav>
  );
}

// A section's icon or presence dot and its name, the same in a sidebar
// row and in a phone chip.
export function SectionLabel({ section }: { section: SettingsSection }) {
  const Icon = section.icon;
  return (
    <>
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
      {section.tone && <StatusDot tone={section.tone} />}
      <span className="truncate">{section.label}</span>
    </>
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
  section,
  active,
}: {
  section: SettingsSection;
  active: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-controls={settingsPanelId(section.id)}
      title={section.title}
      onClick={() => selectSettingsTab(section.id)}
      className={cn(
        WORKTREE_ROW_BUTTON,
        "min-w-0 py-1.5",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <SectionLabel section={section} />
    </button>
  );
}
