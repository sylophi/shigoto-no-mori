// The Settings page's section list for the phone layout, where no
// sidebar holds SettingsSidebarNav: the same sections (settingsSections)
// as one row of chips under the page header, scrolling sideways past
// the edge. The same store underneath, so the header and the panels
// follow a pick here exactly as they follow the sidebar's.
import { ChipButton } from "@/components/ui/chip-button";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import type { RemoteDevice } from "@/lib/remote/devices";
import { cn } from "@/lib/utils";
import { SectionLabel } from "./SettingsSidebarNav";
import {
  selectSettingsTab,
  settingsPanelId,
  settingsSections,
} from "./settingsNav";

export function SettingsSectionChips({
  devices,
  activeTab,
}: {
  devices: readonly RemoteDevice[];
  activeTab: string;
}) {
  const phone = usePhoneLayout();
  const localName = useLocalDeviceName();
  if (!phone) return null;
  const sections = settingsSections(devices, localName);
  return (
    <nav
      aria-label="Settings sections"
      className="flex shrink-0 [scrollbar-width:none] gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
    >
      {[...sections.visual, ...sections.devices].map((section) => {
        const active = activeTab === section.id;
        return (
          <ChipButton
            key={section.id}
            aria-current={active ? "true" : undefined}
            aria-controls={settingsPanelId(section.id)}
            title={section.title}
            onClick={() => selectSettingsTab(section.id)}
            className={cn(
              "max-w-48 shrink-0 py-1.5",
              active && "bg-accent text-foreground",
            )}
          >
            <SectionLabel section={section} />
          </ChipButton>
        );
      })}
    </nav>
  );
}
