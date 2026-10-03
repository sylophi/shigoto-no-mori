// The sidebar's footer, drawn (SidebarFooter, SidebarViewToggle and
// SidebarNavActions read the view, the route and the updates): the
// layout toggle at the left end, the page-nav cluster at the right.
import type { ReactNode } from "react";
import {
  Inbox,
  ListTree,
  MonitorSmartphone,
  Settings as SettingsIcon,
  Trees,
} from "lucide-react";
import type { SidebarView } from "@shared/schemas";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SIDEBAR_FOOTER_BAR, SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

export function SidebarFooterView({
  onDoneArranging,
  toggle,
  actions,
}: {
  // While arranging (this machine's projects), the way out, which
  // stands in for the whole bar. Undefined otherwise.
  onDoneArranging?: () => void;
  // The layout toggle (SidebarViewToggle or SidebarViewToggleView).
  toggle: ReactNode;
  // The page-nav cluster (SidebarNavActions or SidebarNavActionsView).
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
    title: "One list across every project, newest work first",
  },
  {
    value: "projects",
    label: <ListTree aria-hidden className="size-3.5" />,
    title: "Group worktrees by project",
  },
] as const satisfies ReadonlyArray<SegmentedOption<SidebarView>>;

// The inbox / projects flip. Both shells' footers carry it. The phone
// layout has the two views as tabs instead. aria-keyshortcuts restores
// the AT-audible shortcut hint the old native title carried; Base UI
// tooltips are visual-only.
export function SidebarViewToggleView({
  view,
  onChange,
}: {
  view: SidebarView;
  onChange?: (view: SidebarView) => void;
}) {
  return (
    <SegmentedControl<SidebarView>
      value={view}
      onChange={(next) => onChange?.(next)}
      options={VIEW_OPTIONS}
      aria-label="Sidebar layout"
      aria-keyshortcuts="Tab"
      optionClassName="px-1.5 py-1"
    />
  );
}

// The routes the footer's cluster reaches.
export type SidebarNavRoute = "/tidy" | "/devices" | "/settings";

// The footer's page-nav cluster (Tidy, Devices, Settings). Tidy's page
// has no other way in, and the footer is the one bar both sidebar views
// show. The page spans this machine's projects, so a hostless client has
// none to tidy. Devices is always reachable: unconfigured or signed out, the
// page itself explains the state (AccountSection) instead of the button
// hiding. Settings wears a dot while any device's section there holds an
// update this window could install: the local machine's, or a peer's
// (the only kind a hostless client can have).
export function SidebarNavActionsView({
  hasLocalHost,
  updateReady,
  activePath,
  onNavigate,
}: {
  hasLocalHost: boolean;
  updateReady: boolean;
  // The route on screen, which lights its button when it is one of
  // them.
  activePath?: string;
  onNavigate?: (to: SidebarNavRoute) => void;
}) {
  const button = (to: SidebarNavRoute) => ({
    active: activePath === to,
    onClick: () => onNavigate?.(to),
  });
  return (
    <>
      {hasLocalHost && (
        <NavIconButtonView
          tip="Tidy the forest: sizes, staleness, what has landed"
          label="Tidy the forest"
          {...button("/tidy")}
        >
          <Trees className="size-3.5" />
        </NavIconButtonView>
      )}
      <NavIconButtonView tip="Devices" label="Devices" {...button("/devices")}>
        <MonitorSmartphone className="size-3.5" />
      </NavIconButtonView>
      <NavIconButtonView
        tip={updateReady ? "Settings (update available)" : "Settings"}
        label={updateReady ? "Settings (update available)" : "Settings"}
        {...button("/settings")}
      >
        <SettingsIcon className="size-3.5" />
        {updateReady && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 ring-2 ring-card"
          />
        )}
      </NavIconButtonView>
    </>
  );
}

// One shape for the sidebar's route buttons (tidy, devices, settings):
// tooltip, icon, active highlight. NavIconButton works out whether its
// route is the one on screen.
export function NavIconButtonView({
  tip,
  label,
  active,
  onClick,
  children,
}: {
  tip: string;
  label: string;
  active: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <SimpleTooltip tip={tip}>
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
    </SimpleTooltip>
  );
}
