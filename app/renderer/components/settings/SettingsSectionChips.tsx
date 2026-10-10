// The Settings page's section list for the phone layout, where no
// sidebar holds SettingsSidebarNav: the same sections (settingsSections)
// as one row of chips under the page header, scrolling sideways past
// the edge. The same store underneath, so the header and the panels
// follow a pick here exactly as they follow the sidebar's.
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { hasLocalHost } from "@/lib/localHost";
import { SettingsSectionChipsView } from "./SettingsNavView";
import { selectSettingsTab, useSettingsPanelControls } from "./settingsNav";
import { settingsSections } from "./settingsSections";
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
  return (
    <SettingsSectionChipsView
      sections={settingsSections(update, villageLife, hasLocalHost)}
      activeId={activeTab}
      controls={controls}
      onSelect={selectSettingsTab}
    />
  );
}
