import { useNavigate } from "@tanstack/react-router";
import { LayoutGrid, MonitorSmartphone, Radio } from "lucide-react";
import {
  ACCOUNT_SECTION,
  selectSettingsTab,
  settingsSections,
  TIDY_SECTION,
} from "@/components/settings/settingsNav";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { hasLocalHost } from "@/lib/localHost";
import type { PalettePage } from "./buildPaletteEntries";

// The pages the palette can open: the sidebar footer's (Live, the
// project grid, a hostless client's Devices) and Settings' list (the
// account, its sections, Tidy), as this window offers them.
export function usePalettePages(): PalettePage[] {
  const navigate = useNavigate();
  const villageLife = useVillageLife();
  const { client, host } = settingsSections(false, villageLife);
  const pages: PalettePage[] = [
    {
      key: "page:live",
      label: "Live",
      icon: Radio,
      open: () => void navigate({ to: "/live" }),
    },
  ];
  if (hasLocalHost) {
    pages.push(
      {
        key: "page:projects",
        label: "Projects",
        icon: LayoutGrid,
        open: () => void navigate({ to: "/" }),
      },
      {
        key: "page:account",
        label: ACCOUNT_SECTION.label,
        icon: ACCOUNT_SECTION.icon,
        aliases: ["Devices"],
        open: () => void navigate({ to: "/account" }),
      },
      {
        key: "page:tidy",
        label: TIDY_SECTION.label,
        icon: TIDY_SECTION.icon,
        open: () => void navigate({ to: "/tidy" }),
      },
    );
  } else {
    pages.push({
      key: "page:account",
      label: "Devices",
      icon: MonitorSmartphone,
      aliases: [ACCOUNT_SECTION.label],
      open: () => void navigate({ to: "/account" }),
    });
  }
  for (const section of [...client, ...host]) {
    pages.push({
      key: `page:settings:${section.id}`,
      label: section.label,
      icon: section.icon,
      parent: "Settings",
      open: () => {
        selectSettingsTab(section.id);
        void navigate({ to: "/settings" });
      },
    });
  }
  return pages;
}
