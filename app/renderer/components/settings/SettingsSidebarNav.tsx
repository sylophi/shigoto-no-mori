import { useNavigate, useRouter } from "@tanstack/react-router";
import { WORKTREE_ROW_BUTTON } from "@/components/sidebar/WorktreeRow";
import { BackButton } from "@/components/ui/back-button";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatusDot } from "@/components/ui/status-dot";
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
  const router = useRouter();
  const devices = useHostDevices();
  const { activeTab } = useActiveSettingsTab(devices);
  const local = useLocalDevice();
  const solo = isSolo(devices);
  const updates = useStagedUpdates();
  const sections = settingsSections(devices, local, updates);

  return (
    <nav aria-label="Settings sections" className="flex flex-col px-2 pb-2">
      {/* The tree is gone while this list is up, so the way out is the
          first row: back to wherever Settings was opened from. Switching
          sections pushes no history, so one step always leaves the page.
          A window that opened straight onto Settings has nothing behind
          it and goes to "/", which lands on the first worktree, the same
          place a fresh window opens. It spans the row like the rows
          below it, so the whole width is the target and not just the
          word. */}
      <BackButton
        label="Back"
        className="mb-1 ml-0 w-full justify-start"
        onClick={() =>
          router.history.canGoBack()
            ? router.history.back()
            : void navigate({ to: "/" })
        }
      />

      <NavGroup label="Visual">
        {sections.visual.map((section) => (
          <NavRow
            key={section.id}
            section={section}
            active={activeTab === section.id}
          />
        ))}
      </NavGroup>

      <NavGroup
        label={solo ? "Device" : "Devices"}
        action={<UpdateAllButton updates={updates} />}
      >
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
