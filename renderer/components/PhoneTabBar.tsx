// The phone layout's primary navigation: the three places the sidebar's
// footer cluster reaches on a wide viewport, as thumb-sized tabs along
// the bottom edge. A tab lights on its page exactly (the rule
// NavIconButton follows: a peer's worktree under /devices/$deviceId is
// ordinary work, not a device page), and Forest, the home tab, lights
// for everything else, since every other page is reached from it. v1
// draws a card band with an accent pill on the current tab. The
// data-slot hooks let doubutsu restyle the bar as a cream tray with a
// leaf-green sticker on the current tab (doubutsu.css).
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  MonitorSmartphone,
  Settings as SettingsIcon,
  TreeDeciduous,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = {
  to: "/forest" | "/devices" | "/settings";
  label: string;
  icon: LucideIcon;
};

const TABS: readonly Tab[] = [
  { to: "/forest", label: "Forest", icon: TreeDeciduous },
  { to: "/devices", label: "Devices", icon: MonitorSmartphone },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

// Whether a path is one of the tab pages themselves (or the dispatcher
// that lands on one), as opposed to a page stacked over the forest,
// which the shell puts a back bar over.
export function isTabRoute(pathname: string): boolean {
  return pathname === "/" || TABS.some((tab) => tab.to === pathname);
}

export function PhoneTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = TABS.find((tab) => tab.to === pathname)?.to ?? "/forest";
  return (
    <nav
      aria-label="Primary"
      data-slot="phone-tab-bar"
      // The bottom inset keeps the tabs above the home indicator on a
      // notched phone (viewport-fit=cover in the page's meta).
      className="flex shrink-0 items-stretch border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ to, label, icon: Icon }) => {
        const current = to === active;
        return (
          <button
            key={to}
            type="button"
            data-slot="phone-tab"
            onClick={() => void navigate({ to })}
            aria-current={current ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 pt-2 pb-1.5 text-[11px] font-medium transition-colors",
              current
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              data-slot="phone-tab-pill"
              className={cn(
                "flex h-8 w-16 items-center justify-center rounded-full transition-[background-color,color,transform]",
                current && "bg-accent text-accent-foreground",
              )}
            >
              <Icon aria-hidden className="size-5" />
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}
