// The app's window around a sidebar and a page, for composing a whole
// window out of the lab's parts: the desktop layout (the sidebar column
// at its default width, the resize edge, the page in the main zone
// under the title-bar strip) or the phone's (the page over the tab
// bar). It fills the box it is given, which a scene's frame sizes as
// the window it draws.
import type { ReactNode } from "react";
import { AppShellView } from "@/components/AppShellView";
import { PhoneTabBarView } from "@/components/PhoneTabBarView";
import { cn } from "@/lib/utils";
import type { LabShell } from "./world";

export function LabWindow({
  shell = "desktop",
  phone = false,
  sidebar,
  overlays,
  children,
}: {
  shell?: LabShell;
  // The phone layout, which only the web shell draws, on its inbox tab.
  phone?: boolean;
  // Beside the page on a wide window (LabSidebar).
  sidebar?: ReactNode;
  // Over the window, outside the sidebar and the page, where the live
  // app portals its menus and dialogs. The window is their containing
  // block.
  overlays?: ReactNode;
  // The page.
  children?: ReactNode;
}) {
  return (
    <AppShellView
      phone={phone}
      hasLocalHost={shell === "desktop"}
      sidebar={sidebar}
      tabBar={<PhoneTabBarView active="/forest/inbox" updateReady={false} />}
      overlays={overlays}
      className={cn("h-full", overlays !== undefined && "relative")}
    >
      {children}
    </AppShellView>
  );
}
