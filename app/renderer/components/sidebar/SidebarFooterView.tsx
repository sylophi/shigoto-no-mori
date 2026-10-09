// The sidebar's footer (SidebarFooter binds it): what both views share,
// the layout toggle and the app-level actions. Anything that only
// answers a question the project tree asks lives in the toolbar, above
// the tree. While arranging, the bar holds only the way out of it.
import type { ReactNode } from "react";
import {
  Inbox,
  LayoutGrid,
  ListTree,
  MonitorSmartphone,
  Radio,
  Settings as SettingsIcon,
} from "lucide-react";
import type { SidebarView } from "@shigomori/contracts/schemas";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { SIDEBAR_FOOTER_BAR, SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

export function SidebarFooterView({
  onDoneArranging,
  toggle,
  actions,
}: {
  // Set while arranging the projects.
  onDoneArranging?: () => void;
  // The view toggle (SidebarViewToggleView) and the page-nav cluster
  // (SidebarNavActionsView).
  toggle: ReactNode;
  actions: ReactNode;
}) {
  if (onDoneArranging) {
    return (
      <div className={cn(SIDEBAR_FOOTER_BAR, "justify-end")}>
        <button
          type="button"
          onClick={onDoneArranging}
          className="rounded-md px-2 py-1 text-2xs font-semibold tracking-wide text-foreground uppercase transition-colors hover:bg-accent"
        >
          Done arranging
        </button>
      </div>
    );
  }
  return (
    <div className={SIDEBAR_FOOTER_BAR}>
      {toggle}
      <div className="flex-1" />
      {actions}
    </div>
  );
}

const VIEW_OPTIONS = [
  {
    value: "inbox",
    label: <Inbox aria-hidden className="size-3.5" />,
    ariaLabel: "Inbox",
  },
  {
    value: "projects",
    label: <ListTree aria-hidden className="size-3.5" />,
    ariaLabel: "Projects",
  },
] as const satisfies ReadonlyArray<SegmentedOption<SidebarView>>;

// The inbox / projects flip. Both shells' footers carry it. The phone
// layout has the two views as tabs instead. aria-keyshortcuts gives
// assistive tech the Tab shortcut.
export function SidebarViewToggleView({
  view,
  onChange,
}: {
  view: SidebarView;
  onChange: (view: SidebarView) => void;
}) {
  return (
    <SegmentedControl<SidebarView>
      value={view}
      onChange={onChange}
      options={VIEW_OPTIONS}
      aria-label="Sidebar layout"
      aria-keyshortcuts="Tab"
      optionClassName="px-1.5 py-1"
    />
  );
}

// The footer's page-nav cluster (Live, Projects, Settings). Projects is
// the home page's grid, where a fresh window opens, and the footer is
// the one bar both sidebar views show. Devices and tidying are sections
// of Settings. A hostless client's home is the Devices page, so its
// Devices button stands where Projects would: always there, since
// unconfigured or signed out the page itself explains the state.
// Live wears a dot while anything runs, an amber one while an agent
// waits on you instead. Settings wears a dot while any device holds an
// update this window could install.
export function SidebarNavActionsView({
  hasLocalHost,
  pathname,
  live,
  updateReady,
  onNavigate,
}: {
  hasLocalHost: boolean;
  // The page on screen, whose button lights.
  pathname: string;
  live: { label: string; dot: "amber" | "emerald" | null };
  updateReady: boolean;
  onNavigate: (to: "/live" | "/" | "/account" | "/settings") => void;
}) {
  const button = (to: Parameters<typeof onNavigate>[0]) => ({
    active: pathname === to,
    onClick: () => onNavigate(to),
  });
  return (
    <>
      <NavIconButton {...button("/live")} label={live.label}>
        <Radio className="size-3.5" />
        {live.dot !== null && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-card",
              live.dot === "amber" ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
        )}
      </NavIconButton>
      {hasLocalHost ? (
        <NavIconButton {...button("/")} label="Projects">
          <LayoutGrid className="size-3.5" />
        </NavIconButton>
      ) : (
        <NavIconButton {...button("/account")} label="Devices">
          <MonitorSmartphone className="size-3.5" />
        </NavIconButton>
      )}
      <NavIconButton
        {...button("/settings")}
        label={updateReady ? "Settings (update available)" : "Settings"}
      >
        <SettingsIcon className="size-3.5" />
        {updateReady && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 ring-2 ring-card"
          />
        )}
      </NavIconButton>
    </>
  );
}

// One shape for the sidebar's route buttons: icon, and the active
// highlight on the page's own path. The match is exact, so Projects
// ("/") doesn't light on every page.
function NavIconButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        SIDEBAR_ICON_BUTTON,
        "relative",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}
