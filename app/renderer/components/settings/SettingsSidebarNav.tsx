import {
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
} from "@tanstack/react-router";
import { SectionHeading } from "@/components/ui/section-heading";
import { SidebarTakeover } from "@/components/sidebar/SidebarTakeover";
import { useGoBack } from "@/hooks/ui/useGoBack";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { UpdateMark } from "@/components/ui/status-dot";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { hasLocalHost } from "@/lib/localHost";
import { PAGES } from "@/lib/pages";
import { cn } from "@/lib/utils";
import {
  selectSettingsTab,
  settingsSections,
  useActiveSettingsTab,
  useSettingsPanelControls,
  type SettingsSection,
} from "./settingsNav";

// Settings and the pages its list leads to (Tidy, and on a desktop the
// account), as one layout route (router.tsx). The list is drawn in the
// sidebar here, once for all of them, so stepping between them keeps it
// in place rather than replaying its arrival. Switching sections pushes
// no history, so one step back always leaves.
export function SettingsPages() {
  const back = useGoBack();
  return (
    <>
      <SidebarTakeover back={{ label: "Back", onClick: back }}>
        <SettingsSidebarNav />
      </SidebarTakeover>
      <Outlet />
    </>
  );
}

// Whether Settings or a page beside it is open: any route under
// SettingsPages. A hostless client's account page is not one.
export function useOnSettingsPages(): boolean {
  return useMatches({
    select: (matches) => matches.some((m) => m.routeId === "/settings-pages"),
  });
}

// The Settings page's navigation, drawn in the app sidebar in place of
// the project tree while Settings or one of its pages is open
// (SidebarTakeover, which also draws the Back row above it). On a
// desktop the account leads, on a row of its own, then two labelled
// groups: "Client" holds what this window shows and nothing else ever
// sees, and "Host" what each machine stores (its device, worktree and
// integration settings) and what spans its projects (Tidy). Every host
// page picks its machine with the device tab bar in its header, one
// pick for them all (settingsNav), so the list never grows with the
// account. The split is the page's whole point, so the list shows it
// rather than a panel explaining it. The sections come from
// settingsSections, which the phone layout's chip row draws too.
//
// The account and Tidy are pages of their own (the account's sign-in
// and device registry, Tidy's removals) rather than forms, so they
// keep their routes and share this list (SettingsPages). Stepping
// between them and Settings replaces the entry rather than pushing
// one, so one step back still leaves Settings, whichever of them it
// lands on. A hostless client offers neither: its account page is its
// home, and it has no forest of its own to tidy.
function SettingsSidebarNav() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const onPage = pathname !== PAGES.settings.path;
  const activeTab = useActiveSettingsTab();
  const controls = useSettingsPanelControls();
  const update = Object.keys(useStagedUpdates()).length > 0;
  const villageLife = useVillageLife();
  const sections = settingsSections(update, villageLife);
  const row = (section: SettingsSection) => (
    <NavRow
      key={section.id}
      section={section}
      active={!onPage && activeTab === section.id}
      controls={controls(section.id)}
      onSelect={() => {
        selectSettingsTab(section.id);
        if (onPage) void navigate({ to: PAGES.settings.path, replace: true });
      }}
    />
  );
  // A row leading to one of the pages beside Settings, named and drawn
  // as the page list has it.
  const pageRow = (page: SettingsPage) => (
    <NavRow
      section={page}
      active={pathname === page.path}
      onSelect={() => void navigate({ to: page.path, replace: true })}
    />
  );

  return (
    <nav aria-label="Settings sections" className="flex flex-col px-2 pb-2">
      {hasLocalHost && <div className="pt-3">{pageRow(PAGES.account)}</div>}

      <NavGroup label="Client">{sections.client.map(row)}</NavGroup>

      <NavGroup label="Host">
        {sections.host.map(row)}
        {hasLocalHost && pageRow(PAGES.tidy)}
      </NavGroup>
    </nav>
  );
}

// A section's icon and its name, the same in a sidebar row and in a
// phone chip. The General section, while a device holds a staged
// update, trails the sidebar Settings dot's own mark, so the dot that
// brought the visitor here points at the row it meant (and the tab bar
// there at the device).
export function SectionLabel({ section }: { section: RowLabel }) {
  const Icon = section.icon;
  return (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{section.label}</span>
      {section.update && <UpdateMark className="ml-auto" />}
    </>
  );
}

// A labelled group of rows: the eyebrow is the scope, the page's own
// section heading at the sidebar's size so it reads as structure
// rather than as another row.
function NavGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <SectionHeading className="px-2 pt-3 pb-1 text-3xs text-muted-foreground/80">
        {label}
      </SectionHeading>
      {children}
    </div>
  );
}

// The pages beside Settings that its list leads to.
type SettingsPage = (typeof PAGES)["account" | "tidy"];

// What a row or chip draws: a section's, or a page's, name and icon.
type RowLabel = Pick<SettingsSection, "label" | "icon" | "update">;

// One row, with the sidebar rows' selection fill, so the list reads as
// the sidebar's rather than a foreign widget dropped in.
function NavRow({
  section,
  active,
  controls,
  onSelect,
}: {
  section: RowLabel;
  active: boolean;
  // The settings panel the row shows. Tidy's and the account's rows
  // lead to pages.
  controls?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-controls={controls}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <SectionLabel section={section} />
    </button>
  );
}
