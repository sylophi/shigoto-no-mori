// The app's root layout, one for both shells: the sidebar beside the
// routed page in a doubutsu "main" zone. The desktop window and the
// browser tab draw the same frame. What differs is read off the
// platform, never forked per shell. The sidebar edge resizes on both
// (a browser has a mouse too), the title-bar drag strip only exists in
// Electron, and a phone-width browser tab gets the phone layout: a
// bottom tab bar (forest, devices, settings), the forest as a page of
// its own (ForestPage), and the worktree pages stacked over it behind
// a slim back bar. Built in v1 vocabulary (theme tokens only), per the
// theming contract.
import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { AddProjectModal } from "@/components/AddProjectModal";
import { WorktreePalette } from "@/components/palette/WorktreePalette";
import { PhoneTabBar } from "@/components/PhoneTabBar";
import {
  forestTabFor,
  isTabRoute,
} from "@shigomori/ui/views/PhoneTabBarView.tsx";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { UpdateReadyToast } from "@/components/UpdateReadyToast";
import { useWatchAccountChanges } from "@/hooks/account/useAccount";
import { useDoctorWatch } from "@/hooks/cli/useDoctor";
import { useSidebarView } from "@/hooks/projects/useSidebarView";
import { useOpenProject } from "@/components/sidebar/openProject";
import { useProjects } from "@/hooks/projects/useProjects";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useDeepLinks } from "@/hooks/ui/useDeepLinks";
import { useEscapeGoesBack } from "@/hooks/ui/useEscapeGoesBack";
import { useResizableWidth } from "@/hooks/ui/useResizableWidth";
import { usePaletteVariantHotkey } from "@/hooks/ui/usePaletteVariantHotkey";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { hasLocalHost } from "@/lib/localHost";
import {
  AppShellView,
  PhoneBackBarView,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "@shigomori/ui/views/AppShellView.tsx";

export function AppShell() {
  // The always-mounted account watch, keeping every staleTime-Infinity
  // account read fresh across sign-in, sign-out and renames.
  useWatchAccountChanges();
  // This machine's daily health check, for Settings' last-check line.
  useDoctorWatch();
  const phone = usePhoneLayout();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  usePaletteVariantHotkey(!pathname.startsWith("/settings"));
  useEscapeGoesBack();
  // The forest tab a stacked page returns to on a phone.
  const forestTab = forestTabFor(useSidebarView());
  const sidebar = useResizableWidth({
    storageKey: "sidebar.width",
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    fallback: SIDEBAR_DEFAULT,
  });

  // The layout rides <html> as a data attribute, like the theme
  // classes, so the `phone:` variant (index.css) reaches every element
  // -- portaled overlays and the toaster included. The web boot script
  // stamps it pre-paint. This keeps it in step with resizes.
  useEffect(() => {
    if (phone) document.documentElement.dataset["layout"] = "phone";
    else delete document.documentElement.dataset["layout"];
  }, [phone]);

  // The app menu's Settings item (a client-scoped broadcast that only
  // the desktop's menu ever sends).
  useEffect(
    () =>
      window.api.nav.onOpenSettings(() => {
        void navigate({ to: "/settings" });
      }),
    [navigate],
  );

  useDeepLinks();

  return (
    <AppShellView
      phone={phone}
      hasLocalHost={hasLocalHost}
      sidebar={<Sidebar />}
      sidebarWidth={sidebar.width}
      onResizeStart={sidebar.onMouseDown}
      // Updates found on this machine or a peer, announced once each.
      toasts={<UpdateReadyToast />}
      backBar={
        !isTabRoute(pathname) && (
          <PhoneBackBarView
            label={forestTab.label}
            onBack={() => void navigate(forestTab.to)}
          />
        )
      }
      tabBar={<PhoneTabBar />}
      overlays={
        // The app-wide overlays. They live here, under the router, so
        // their navigation is plain useNavigate. The ⌘K worktree palette
        // spans every device, and add project picks its device, so a
        // hostless client has both.
        <>
          {phone && <ForestKeepalive />}
          <WorktreePalette />
          <AddProjectModal />
        </>
      }
    >
      <Outlet />
    </AppShellView>
  );
}

// The wide layout's sidebar is always mounted and keeps every peer's
// views streaming. The phone layout's forest is a page that unmounts on
// every tab switch. One reader here keeps them streaming, so coming
// back to the forest paints at once instead of from "Loading forests…"
// while every peer's views start again. It stands in for the forest's
// other standing job too: opening the project of the page on screen
// (openProject.ts), so the Projects tab comes back inside the project
// just visited.
function ForestKeepalive() {
  const { items } = useRemoteForests();
  const { data: projects = [] } = useProjects();
  useOpenProject(projects, items);
  return null;
}
