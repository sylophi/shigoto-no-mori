// The Settings page's section list for the phone layout, where no
// sidebar holds SettingsSidebarNav: the same sections (settingsSections)
// as one row of chips under the page header, scrolling sideways past
// the edge. The same store underneath, so the header and the panels
// follow a pick here exactly as they follow the sidebar's.
import { ChipButton } from "@/components/ui/chip-button";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { cn } from "@/lib/utils";
import { SectionLabel } from "./SettingsSidebarNav";
import {
  selectSettingsTab,
  settingsSections,
  useSettingsPanelControls,
  type SettingsSection,
} from "./settingsNav";
import { useVillageLife } from "@/hooks/config/useVillageLife";

export function SettingsSectionChips({
  activeTab,
  update,
}: {
  activeTab: string;
  // Whether any device holds a staged update (settingsSections).
  update: boolean;
}) {
  const phone = usePhoneLayout();
  const villageLife = useVillageLife();
  const controls = useSettingsPanelControls();
  if (!phone) return null;
  const sections = settingsSections(update, villageLife);
  const chip = (section: SettingsSection) => {
    const active = activeTab === section.id;
    return (
      <ChipButton
        key={section.id}
        aria-current={active ? "true" : undefined}
        aria-controls={controls(section.id)}
        onClick={() => selectSettingsTab(section.id)}
        className={cn(
          "max-w-48 shrink-0 py-1.5",
          active && "bg-accent text-foreground",
        )}
      >
        <SectionLabel section={section} />
      </ChipButton>
    );
  };
  return (
    <nav
      aria-label="Settings sections"
      className="flex shrink-0 [scrollbar-width:none] gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
    >
      {sections.client.map(chip)}
      {sections.host.map(chip)}
    </nav>
  );
}
