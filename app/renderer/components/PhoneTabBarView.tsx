// The phone layout's tab bar, drawn (PhoneTabBar lights it off the
// route and the view, and navigates): the sidebar's two views and the
// two places its footer cluster reaches on a wide viewport, as
// thumb-sized tabs along the bottom edge. v1 draws a card band with an
// accent pill on the current tab. The data-slot hooks let doubutsu
// restyle the bar as a cream tray with a leaf-green sticker on the
// current tab (doubutsu.css).
import {
  Inbox,
  MonitorSmartphone,
  Settings as SettingsIcon,
  TreeDeciduous,
  type LucideIcon,
} from "lucide-react";
import type { SidebarView } from "@shared/schemas";
import { cn } from "@/lib/utils";

// The forest tabs share one route, told apart by its view param.
export type Tab = {
  label: string;
  icon: LucideIcon;
  pathname: string;
  to:
    | { to: "/forest/$view"; params: { view: SidebarView } }
    | { to: "/devices" | "/settings" };
};

const forestTab = (
  view: SidebarView,
  label: string,
  icon: LucideIcon,
): Tab => ({
  label,
  icon,
  pathname: `/forest/${view}`,
  to: { to: "/forest/$view", params: { view } },
});

export const TABS: readonly [Tab, ...Tab[]] = [
  forestTab("inbox", "Inbox", Inbox),
  forestTab("projects", "Projects", TreeDeciduous),
  {
    label: "Devices",
    icon: MonitorSmartphone,
    pathname: "/devices",
    to: { to: "/devices" },
  },
  {
    label: "Settings",
    icon: SettingsIcon,
    pathname: "/settings",
    to: { to: "/settings" },
  },
];

// The forest tab a view lives on: where a page stacked over the forest
// returns to, and what lights while it is open.
export function forestTabFor(view: SidebarView): Tab {
  return TABS.find((tab) => tab.pathname === `/forest/${view}`) ?? TABS[0];
}

// Whether a path is one of the tab pages themselves (or the dispatcher
// that lands on one), as opposed to a page stacked over the forest,
// which the shell puts a back bar over.
export function isTabRoute(pathname: string): boolean {
  return pathname === "/" || TABS.some((tab) => tab.pathname === pathname);
}

export function PhoneTabBarView({
  active,
  updateReady,
  onNavigate,
}: {
  // The current tab's pathname (a tab's `pathname`).
  active: string;
  // The Settings tab is the phone's Settings icon, so it wears the
  // sidebar's update dot (SidebarNavActions).
  updateReady: boolean;
  onNavigate?: (tab: Tab) => void;
}) {
  return (
    <nav
      aria-label="Primary"
      data-slot="phone-tab-bar"
      // The bottom inset keeps the tabs above the home indicator on a
      // notched phone (viewport-fit=cover in the page's meta).
      className="flex shrink-0 items-stretch border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map((tab) => {
        const { label, icon: Icon, pathname: tabPath } = tab;
        const isCurrent = tabPath === active;
        return (
          <button
            key={tabPath}
            type="button"
            data-slot="phone-tab"
            onClick={() => onNavigate?.(tab)}
            aria-current={isCurrent ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 pt-2 pb-1.5 text-2xs font-medium transition-colors",
              isCurrent
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              data-slot="phone-tab-pill"
              className={cn(
                "relative flex h-8 w-16 items-center justify-center rounded-full transition-[background-color,color,transform]",
                isCurrent && "bg-accent text-accent-foreground",
              )}
            >
              <Icon aria-hidden className="size-5" />
              {tabPath === "/settings" && updateReady && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1 right-4.5 size-1.5 rounded-full bg-sky-500"
                />
              )}
            </span>
            {label}
            {tabPath === "/settings" && updateReady && (
              <span className="sr-only">(update available)</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
