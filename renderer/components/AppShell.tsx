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
import { ProjectLauncher } from "@/components/launcher/ProjectLauncher";
import {
  forestTabFor,
  isTabRoute,
  PhoneTabBar,
} from "@/components/PhoneTabBar";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { BackButton } from "@/components/ui/back-button";
import { useWatchAccountChanges } from "@/hooks/account/useAccount";
import { useSidebarView } from "@/hooks/projects/useSidebarView";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { useResizableWidth } from "@/hooks/ui/useResizableWidth";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { hasLocalHost } from "@/lib/localHost";
import { cn, dragRegion } from "@/lib/utils";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;

export function AppShell() {
  // The always-mounted account watch, keeping every staleTime-Infinity
  // account read fresh across sign-in, sign-out and renames.
  useWatchAccountChanges();
  const phone = usePhoneLayout();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The forest tab a stacked page returns to on a phone.
  const forestTab = forestTabFor(useSidebarView());
  const sidebar = useResizableWidth({
    storageKey: "sidebar.width",
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    fallback: SIDEBAR_DEFAULT,
    leftEdge: () => 0,
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

  return (
    <div
      className={cn(
        "flex h-dvh overflow-hidden text-foreground",
        // The desktop window is transparent so the sidebar's vibrancy
        // material shows through, and the main pane paints its own
        // background. A browser tab has no material, so the root paints.
        !hasLocalHost && "bg-background",
        // A notched phone draws under its status bar (viewport-fit=cover
        // in the page's meta), so the frame steps down past it.
        phone && "pt-[env(safe-area-inset-top)]",
      )}
    >
      {!phone && (
        <>
          <div style={{ width: sidebar.width }} className="shrink-0">
            <Sidebar />
          </div>
          <div
            onMouseDown={sidebar.onMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            tabIndex={-1}
            className="relative w-px shrink-0 cursor-col-resize bg-border"
          >
            <div className="absolute inset-y-0 -left-1 w-2" />
          </div>
        </>
      )}

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {phone && !isTabRoute(pathname) && (
          /* A page stacked over the forest: the way back to it, where a
             wide viewport keeps the sidebar. Thumb-height on purpose. */
          <header className="flex shrink-0 items-center border-b border-border bg-card px-4 py-1">
            <BackButton
              label={forestTab.label}
              onClick={() => void navigate(forestTab.to)}
              className="min-h-10 text-sm"
            />
          </header>
        )}
        <main
          data-doubutsu-zone="main"
          className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
        >
          {/* The window's title-bar drag strip over the page. Only
              where there is a title bar: in a browser the strip would
              be an invisible layer swallowing taps along the top. */}
          {hasLocalHost && (
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 z-30 h-7"
              style={dragRegion("drag")}
            />
          )}
          <Outlet />
        </main>
        {phone && <PhoneTabBar />}
      </div>

      {phone && <ForestKeepalive />}

      {/* The two overlays that act on local projects (the ⌘K launcher,
          add project). They live here, under the router, so their
          navigation is plain useNavigate, and only where there are
          local projects to act on. */}
      {hasLocalHost && (
        <>
          <ProjectLauncher />
          <AddProjectModal />
        </>
      )}
    </div>
  );
}

// The wide layout's sidebar is always mounted and keeps every peer's
// listing fresh. The phone layout's forest is a page that unmounts on
// every tab switch. One calm observer here keeps the cache warm, so
// coming back to the forest paints from it instead of from "Loading
// forests…" while every peer is re-listed.
function ForestKeepalive() {
  useRemoteForests();
  return null;
}
