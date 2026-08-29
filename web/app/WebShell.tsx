// The web client's root layout: the browser twin of the desktop's
// RootLayout (renderer/router.tsx) -- a sidebar beside the routed page
// in a doubutsu "main" zone, so the whole client wears the app's chrome
// rather than a website's. The browser tailoring is exactly the layout
// response: on narrow viewports the sidebar folds into a slide-over
// sheet behind a slim top bar, and there is no window-chrome drag
// region or resize handle. Built in v1 vocabulary (theme tokens only),
// per the theming contract.
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useWatchAccountChanges } from "@/hooks/account/useAccount";
import { WebSidebar } from "./WebSidebar";

export function WebShell() {
  // The always-mounted account watch (the web counterpart of the
  // desktop's SidebarFooter mount), keeping every staleTime-Infinity
  // account read fresh across sign-in, sign-out and renames.
  useWatchAccountChanges();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { pathname } = useLocation();

  // Navigating from a sheet row lands on the new page; the sheet's job
  // is done, so it follows the navigation closed.
  useEffect(() => setSheetOpen(false), [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* Wide viewports: the desktop's static sidebar + hairline
          separator. The separator keeps the desktop's role so the
          doubutsu overlay styles it as the sidebar's mint edge. */}
      <div className="hidden w-60 shrink-0 md:block">
        <WebSidebar />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Sidebar edge"
        className="hidden w-px shrink-0 bg-border md:block"
      />

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Narrow viewports: a slim bar carrying the brand and the
            sidebar toggle. */}
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 md:hidden">
          <button
            type="button"
            aria-label="Open sidebar"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelLeft className="size-4" />
          </button>
          <span className="truncate text-[13px] font-semibold tracking-tight">
            Shigoto no Mori
          </span>
        </header>
        <main
          data-doubutsu-zone="main"
          className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
        >
          <Outlet />
        </main>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        {/* No close X: it would float over the brand header, and the
            backdrop tap, Esc, and any navigation already close it. */}
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-72 gap-0 p-0"
        >
          <SheetTitle className="sr-only">Sidebar</SheetTitle>
          <WebSidebar />
        </SheetContent>
      </Sheet>
    </div>
  );
}
