// The app's window around a sidebar and a page, for composing a whole
// window out of scenes: the desktop layout (the sidebar column at its
// default width, the resize edge, the page in the main zone under the
// title-bar strip) or the phone's (the page over the tab bar).
import type { ReactNode } from "react";
import { AppShellView } from "@/components/AppShellView";
import { PhoneTabBarView } from "@/components/PhoneTabBarView";
import type { LabShell } from "./world";

export function AppWindowScene({
  shell = "desktop",
  phone = false,
  sidebar,
  tab = "/forest/inbox",
  overlays,
  className,
  children,
}: {
  shell?: LabShell;
  // The phone layout, which only the web shell draws.
  phone?: boolean;
  // Beside the page on a wide window (LabSidebar).
  sidebar?: ReactNode;
  // The phone's current tab, by its route.
  tab?: string;
  // Over the window, outside the sidebar and the page, where the live
  // app portals its menus and dialogs.
  overlays?: ReactNode;
  // Over the window's own classes: it fills the viewport, so a frame
  // smaller than one passes h-full.
  className?: string;
  // The page.
  children?: ReactNode;
}) {
  return (
    <AppShellView
      phone={phone}
      hasLocalHost={shell === "desktop"}
      sidebar={sidebar}
      tabBar={<PhoneTabBarView active={tab} updateReady={false} />}
      overlays={overlays}
      className={className}
    >
      {children}
    </AppShellView>
  );
}
