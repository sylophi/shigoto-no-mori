import { useNavigate } from "@tanstack/react-router";
import {
  LayoutGrid,
  MonitorSmartphone,
  Radio,
  Settings as SettingsIcon,
  SquareTerminal,
} from "lucide-react";
import { useCommandableDevices } from "@/components/shared/DeviceTabs";
import { openDeviceTerminal } from "@/components/terminal/DeviceTerminalDrawer";
import { selectSettingsTab } from "@/components/settings/settingsNav";
import {
  ACCOUNT_SECTION,
  settingsSections,
  TIDY_SECTION,
} from "@shigomori/ui/views/settings/settingsSections.ts";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { useKeymap } from "@/hooks/ui/useKeymap";
import { useHasLocalHost } from "@/lib/localHost";
import type { PalettePage } from "@shigomori/ui/views/palette/paletteEntries.ts";

// The pages the palette can open: the sidebar footer's (Live, the
// project grid, a hostless client's Devices), and Settings' list (the
// account, its sections, Tidy), as this window offers them. And a new
// terminal on each device that takes commands from here, in the device
// drawer over the page.
export function usePalettePages(): PalettePage[] {
  const hasLocalHost = useHasLocalHost();
  const navigate = useNavigate();
  const settingsKeys = useKeymap().get("settings");
  const villageLife = useVillageLife();
  const { client, host } = settingsSections(false, villageLife, hasLocalHost);
  const devices = useCommandableDevices();
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
    const { deviceId, label, isThisDevice } = device;
    pages.push({
      key: `page:terminal:${deviceId}`,
      label: isThisDevice ? "Terminal" : `Terminal on ${label}`,
      icon: SquareTerminal,
      aliases: ["Shell"],
      open: () => openDeviceTerminal(device),
    });
  }
  // Settings itself, on the section it was left on.
  pages.push({
    key: "page:settings",
    label: "Settings",
    icon: SettingsIcon,
    keys: settingsKeys?.label,
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
