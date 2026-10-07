// The app's own pages, named once (paths stay literal, as in routePaths.ts).
import {
  CircleUserRound,
  LayoutGrid,
  MonitorSmartphone,
  Radio,
  Settings,
  Trees,
  type LucideIcon,
} from "lucide-react";
import { hasLocalHost } from "@/lib/localHost";

interface Page {
  path: string;
  label: string;
  icon: LucideIcon;
}

export const PAGES = {
  home: { path: "/", label: "Projects", icon: LayoutGrid },
  live: { path: "/live", label: "Live", icon: Radio },
  settings: { path: "/settings", label: "Settings", icon: Settings },
  tidy: { path: "/tidy", label: "Tidy the forest", icon: Trees },
  // A page of Settings on a desktop, a hostless client's home page.
  account: {
    path: "/account",
    ...(hasLocalHost
      ? { label: "Account", icon: CircleUserRound }
      : { label: "Devices", icon: MonitorSmartphone }),
  },
} as const satisfies Record<string, Page>;
