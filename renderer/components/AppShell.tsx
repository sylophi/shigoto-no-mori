// The app's root layout, one for both shells: the sidebar beside the
// routed page in a doubutsu "main" zone. The desktop window and the
// browser tab draw the same frame. What differs is read off the
// platform, never forked per shell. The sidebar edge resizes on both
// (a browser has a mouse too), the title-bar drag regions are inert
// outside Electron, and on a narrow viewport the sidebar folds into a
// slide-over sheet behind a slim top bar (the desktop window's minimum
// width keeps it wide, so this is the browser's case in practice).
// Built in v1 vocabulary (theme tokens only), per the theming contract.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import { AddProjectModal } from "@/components/AddProjectModal";
import { ProjectLauncher } from "@/components/launcher/ProjectLauncher";
import { useSelectedSettingsTab } from "@/components/settings/settingsNav";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { SIDEBAR_ICON_BUTTON } from "@/components/sidebar/sidebarChrome";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useWatchAccountChanges } from "@/hooks/account/useAccount";
import { hasLocalHost } from "@/lib/localHost";
import { readStored, writeStored } from "@/lib/localStorage";
import { cn, dragRegion } from "@/lib/utils";

const SIDEBAR_KEY = "sidebar.width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;

function readStoredWidth(): number {
  const raw = readStored(SIDEBAR_KEY);
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
}

// Tailwind's md breakpoint, as a real render gate rather than a CSS
// `hidden`: the static sidebar runs the full forest query fan-out, and
// a phone-width session must not pay for a permanently invisible copy
// of it (nor run two copies while the sheet is open). One
// MediaQueryList for both the subscription and the snapshot, created
// on first use so importing this module needs no window.
let wideMedia: MediaQueryList | null = null;
const wideQuery = () => (wideMedia ??= window.matchMedia("(min-width: 48rem)"));

function subscribeToWide(onChange: () => void): () => void {
  wideQuery().addEventListener("change", onChange);
  return () => wideQuery().removeEventListener("change", onChange);
}

function useIsWideViewport(): boolean {
  return useSyncExternalStore(subscribeToWide, () => wideQuery().matches);
}

export function AppShell() {
  // The always-mounted account watch, keeping every staleTime-Infinity
  // account read fresh across sign-in, sign-out and renames.
  useWatchAccountChanges();
  // The desktop window never folds: its minimum width sits below the
  // breakpoint, and a folded sidebar would put its toggle under the
  // traffic lights. The sheet is the browser tab's layout.
  const viewportWide = useIsWideViewport();
  const wide = hasLocalHost || viewportWide;
  const [sheetOpen, setSheetOpen] = useState(false);
  const { pathname } = useLocation();
  const settingsTab = useSelectedSettingsTab();
  const navigate = useNavigate();
  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredWidth);

  // The app menu's Settings item (a client-scoped broadcast that only
  // the desktop's menu ever sends).
  useEffect(
    () =>
      window.api.nav.onOpenSettings(() => {
        void navigate({ to: "/settings" });
      }),
    [navigate],
  );

  // Navigating from a sheet row lands on the new page, and picking a
  // Settings section swaps the panel beside it. Either way the sheet's
  // job is done, so it follows the choice closed.
  useEffect(() => setSheetOpen(false), [pathname, settingsTab]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    Object.assign(document.body.style, {
      cursor: "col-resize",
      userSelect: "none",
    });
    let last = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      last = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
      setSidebarWidth(last);
    };
    const onUp = () => {
      Object.assign(document.body.style, {
        cursor: "",
        userSelect: "",
      });
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      writeStored(SIDEBAR_KEY, String(Math.round(last)));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={cn(
        "flex h-dvh overflow-hidden text-foreground",
        // The desktop window is transparent so the sidebar's vibrancy
        // material shows through, and the main pane paints its own
        // background. A browser tab has no material, so the root paints.
        !hasLocalHost && "bg-background",
      )}
    >
      {wide ? (
        <>
          <div style={{ width: sidebarWidth }} className="shrink-0">
            <Sidebar />
          </div>
          <div
            onMouseDown={startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            tabIndex={-1}
            className="relative w-px shrink-0 cursor-col-resize bg-border"
          >
            <div className="absolute inset-y-0 -left-1 w-2" />
          </div>
        </>
      ) : null}

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {!wide && (
          /* Narrow viewports: a slim bar carrying the brand and the
             sidebar toggle. */
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
            <button
              type="button"
              aria-label="Open sidebar"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen(true)}
              className={SIDEBAR_ICON_BUTTON}
            >
              <PanelLeft className="size-4" />
            </button>
            <span className="truncate text-[13px] font-semibold tracking-tight">
              Shigoto no Mori
            </span>
          </header>
        )}
        <main
          data-doubutsu-zone="main"
          className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
        >
          {/* The window's title-bar drag strip over the page. Inert
              outside Electron. */}
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 z-30 h-7"
            style={dragRegion("drag")}
          />
          <Outlet />
        </main>
      </div>

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

      {!wide && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          {/* No close X: it would float over the brand header, and the
              backdrop tap, Esc, and any navigation already close it. */}
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-72 gap-0 p-0"
          >
            <SheetTitle className="sr-only">Sidebar</SheetTitle>
            <Sidebar />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
