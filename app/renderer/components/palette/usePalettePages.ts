import { useNavigate } from "@tanstack/react-router";
import {
  LayoutGrid,
  MonitorSmartphone,
  Radio,
  Settings as SettingsIcon,
  SquareTerminal,
} from "lucide-react";
import { useDeviceTabs } from "@/components/shared/DeviceTabs";
import { DEVICE_TERMINALS_PATH } from "@/lib/routePaths";
import { selectSettingsTab } from "@/components/settings/settingsNav";
import {
  ACCOUNT_SECTION,
  settingsSections,
  TIDY_SECTION,
} from "@shigomori/ui/views/settings/settingsSections.ts";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { hasLocalHost } from "@/lib/localHost";
import type { PalettePage } from "@shigomori/ui/views/palette/paletteEntries.ts";

// The pages the palette can open: the sidebar footer's (Live, the
// project grid, a hostless client's Devices), each device's own
// terminals, and Settings' list (the account, its sections, Tidy), as
// this window offers them.
export function usePalettePages(): PalettePage[] {
  const navigate = useNavigate();
  const villageLife = useVillageLife();
  const { client, host } = settingsSections(false, villageLife, hasLocalHost);
  const devices = useDeviceTabs().filter(
    (device) => device.block === undefined,
  );
  const pages: PalettePage[] = [
    {
      key: "page:live",
      label: "Live",
      icon: Radio,
      open: () => void navigate({ to: "/live" }),
    },
    // A hostless client's account page is its home, the footer's
    // Devices.
    {
      key: "page:account",
      label: hasLocalHost ? ACCOUNT_SECTION.label : "Devices",
      icon: hasLocalHost ? ACCOUNT_SECTION.icon : MonitorSmartphone,
      aliases: [hasLocalHost ? "Devices" : ACCOUNT_SECTION.label],
      open: () => void navigate({ to: "/account" }),
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
        key: "page:tidy",
        label: TIDY_SECTION.label,
        icon: TIDY_SECTION.icon,
        open: () => void navigate({ to: "/tidy" }),
      },
    );
  }
  for (const device of devices) {
    pages.push({
      key: `page:terminals:${device.deviceId}`,
      label: device.isThisDevice ? "Terminals" : `Terminals on ${device.label}`,
      icon: SquareTerminal,
      aliases: ["Shell"],
      open: () =>
        void navigate({
          to: DEVICE_TERMINALS_PATH,
          params: { deviceId: device.deviceId },
        }),
    });
  }
  // Settings itself, on the section it was left on.
  pages.push({
    key: "page:settings",
    label: "Settings",
    icon: SettingsIcon,
    open: () => void navigate({ to: "/settings" }),
  });
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
