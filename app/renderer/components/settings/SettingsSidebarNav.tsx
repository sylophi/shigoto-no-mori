import {
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
} from "@tanstack/react-router";
import { SidebarTakeover } from "@/components/sidebar/SidebarTakeover";
import { useGoBack } from "@/hooks/ui/useGoBack";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { useStagedUpdates } from "@/hooks/system/useUpdater";
import { hasLocalHost } from "@/lib/localHost";
import {
  selectSettingsTab,
  useActiveSettingsTab,
  useSettingsPanelControls,
} from "./settingsNav";
import {
  ACCOUNT_SECTION,
  settingsSections,
  TIDY_SECTION,
} from "@shigomori/ui/views/settings/settingsSections.ts";
import { SettingsSidebarNavView } from "@shigomori/ui/views/settings/SettingsNavView.tsx";

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

// The list (SettingsSidebarNavView) in the sidebar while Settings or a
// page beside it is open. Stepping between them and Settings replaces
// the entry rather than pushing one, so one step back still leaves
// Settings, whichever of them it lands on. A hostless client offers
// neither page: its account page is its home, and it has no forest of
// its own to tidy.
function SettingsSidebarNav() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const onPage = pathname !== SETTINGS_PATH;
  const activeTab = useActiveSettingsTab();
  const controls = useSettingsPanelControls();
  const update = Object.keys(useStagedUpdates()).length > 0;
  const villageLife = useVillageLife();
  const pageRow = (section: typeof ACCOUNT_SECTION, to: PagePath) => ({
    section,
    active: pathname === to,
    onSelect: () => void navigate({ to, replace: true }),
  });
  return (
    <SettingsSidebarNavView
      sections={settingsSections(update, villageLife, hasLocalHost)}
      activeId={onPage ? null : activeTab}
      controls={controls}
      onSelect={(id) => {
        selectSettingsTab(id);
        if (onPage) void navigate({ to: SETTINGS_PATH, replace: true });
      }}
      account={hasLocalHost ? pageRow(ACCOUNT_SECTION, "/account") : null}
      tidy={hasLocalHost ? pageRow(TIDY_SECTION, "/tidy") : null}
    />
  );
}

const SETTINGS_PATH = "/settings";
type PagePath = "/tidy" | "/account";
