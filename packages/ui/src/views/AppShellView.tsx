// The app's root layout, drawn (AppShell feeds it the sidebar, the
// routed page and the layout): the sidebar beside the page in a
// doubutsu "main" zone on a wide viewport, and on a phone the page over
// a bottom tab bar, with a back bar over a page stacked on the forest.
import type { MouseEvent, ReactNode } from "react";
import { BackButton } from "../primitives/back-button.tsx";
import { cn, dragRegion } from "../lib/utils.ts";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 240;

interface AppShellViewProps {
  // The phone layout (usePhoneLayout), which mounts a different shell,
  // so the caller decides it rather than a stylesheet.
  phone: boolean;
  // The desktop window, which has a title bar to drag by and paints no
  // root background of its own (the sidebar's material shows through).
  hasLocalHost: boolean;
  // The sidebar, beside the page on a wide viewport. The phone layout
  // has none: the forest is a page there (ForestPageView). Null for a
  // page in place of the app, which takes the whole window.
  sidebar?: ReactNode;
  sidebarWidth?: number;
  // The resize handle's drag (useResizableWidth).
  onResizeStart?: (event: MouseEvent<HTMLDivElement>) => void;
  // The phone's back bar over a page stacked on the forest
  // (PhoneBackBarView), and its tab bar (PhoneTabBarView).
  backBar?: ReactNode;
  tabBar?: ReactNode;
  // Mounted between the sidebar and the page (the update toast) and
  // after the page (the app-wide overlays).
  toasts?: ReactNode;
  overlays?: ReactNode;
  // The routed page.
  children: ReactNode;
  // Over the root's own classes, such as h-full in place of the
  // viewport's height for a picture of a window.
  className?: string;
}

export function AppShellView({
  phone,
  hasLocalHost,
  sidebar,
  sidebarWidth = SIDEBAR_DEFAULT,
  onResizeStart,
  backBar,
  tabBar,
  toasts,
  overlays,
  children,
  className,
}: AppShellViewProps) {
  return (
    <div
      className={cn(
        "flex h-full overflow-hidden text-foreground",
        // The desktop window is transparent so the sidebar's vibrancy
        // material shows through, and the main pane paints its own
        // background. A browser tab has no material, so the root paints.
        !hasLocalHost && "bg-background",
        // A notched phone draws under its status bar (viewport-fit=cover
        // in the page's meta), so the frame steps down past it.
        phone && "pt-[env(safe-area-inset-top)]",
        className,
      )}
    >
      {!phone && sidebar !== null && (
        <>
          <div style={{ width: sidebarWidth }} className="shrink-0">
            {sidebar}
          </div>
          <div
            onMouseDown={onResizeStart}
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

      {toasts}

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {phone && backBar}
        <main
          data-doubutsu-zone="main"
          className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
        >
          {/* The window's title-bar drag strip over the page. Only
              where there is a title bar: in a browser the strip would
              be an invisible layer swallowing taps along the top. The
              drag region is the OS's, so the page's own hit testing
              passes through to a no-drag control under it (the device
              tabs, which sit on the traffic-light line). */}
          {hasLocalHost && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-30 h-7"
              style={dragRegion("drag")}
            />
          )}
          {children}
        </main>
        {phone && tabBar}
      </div>

      {overlays}
    </div>
  );
}

// A page stacked over the forest on a phone: the way back to it, where
// a wide viewport keeps the sidebar. Its full touch height is drawn,
// not left to the hit-area net: the page body under the bar is later
// in the document and would win the overhang.
export function PhoneBackBarView({
  label,
  onBack,
}: {
  // The forest tab it returns to.
  label: string;
  onBack?: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center border-b border-border bg-card px-4 py-1">
      <BackButton
        label={label}
        onClick={() => onBack?.()}
        className="min-h-10 text-sm"
      />
    </header>
  );
}
