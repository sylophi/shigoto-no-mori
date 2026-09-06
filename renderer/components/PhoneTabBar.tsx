// The phone layout's primary navigation: the sidebar's two views and
// the two places its footer cluster reaches on a wide viewport, as
// thumb-sized tabs along the bottom edge. A tab lights on its page
// exactly (the rule NavIconButton follows: a peer's worktree under
// /devices/$deviceId is ordinary work, not a device page), and for
// everything else the forest tab the layout preference names lights,
// since every other page is reached from one of them (the forest page
// keeps that preference in step with its route). v1 draws a card band
// with an accent pill on the current tab. The data-slot hooks let
// doubutsu restyle the bar as a cream tray with a leaf-green sticker
// on the current tab (doubutsu.css).
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Inbox,
  MonitorSmartphone,
  Settings as SettingsIcon,
  TreeDeciduous,
  type LucideIcon,
} from "lucide-react";
import type { SidebarView } from "@shared/schemas";
import { useSidebarView } from "@/hooks/projects/useSidebarView";
import { cn } from "@/lib/utils";

// The forest tabs share one route, told apart by its view param.
type Tab = {
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

const TABS: readonly Tab[] = [
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
  return TABS.find((tab) => tab.pathname === `/forest/${view}`) ?? TABS[0]!;
}

// Whether a path is one of the tab pages themselves (or the dispatcher
// that lands on one), as opposed to a page stacked over the forest,
// which the shell puts a back bar over.
export function isTabRoute(pathname: string): boolean {
  return pathname === "/" || TABS.some((tab) => tab.pathname === pathname);
}

export function PhoneTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const view = useSidebarView();
  const active =
    TABS.find((tab) => tab.pathname === pathname)?.pathname ??
    forestTabFor(view).pathname;
  return (
    <nav
      aria-label="Primary"
      data-slot="phone-tab-bar"
      // The bottom inset keeps the tabs above the home indicator on a
      // notched phone (viewport-fit=cover in the page's meta).
      className="flex shrink-0 items-stretch border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ label, icon: Icon, pathname: tabPath, to }) => {
        const isCurrent = tabPath === active;
        return (
          <button
            key={tabPath}
            type="button"
            data-slot="phone-tab"
            onClick={() => void navigate(to)}
            aria-current={isCurrent ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 pt-2 pb-1.5 text-[11px] font-medium transition-colors",
              isCurrent
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              data-slot="phone-tab-pill"
              className={cn(
                "flex h-8 w-16 items-center justify-center rounded-full transition-[background-color,color,transform]",
                isCurrent && "bg-accent text-accent-foreground",
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
