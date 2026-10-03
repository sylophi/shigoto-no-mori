// The app's window around a sidebar and a page, for composing a whole
// window out of the lab's parts: the desktop app's (the sidebar column
// at its default width, the resize edge, the page in the main zone
// under the title-bar strip) or the web app's on a phone (the page
// over the tab bar, on its inbox tab). It fills the box it is given,
// which a scene's frame sizes as the window it draws.
import type { ReactNode } from "react";
import { AppShellView } from "@/components/AppShellView";
import { PhoneTabBarView } from "@/components/PhoneTabBarView";
import { cn } from "@/lib/utils";
import type { SceneWindow } from "./index";

export function LabWindow({
  window = "desktop",
  sidebar,
  overlays,
  children,
}: {
  window?: SceneWindow;
  // Beside the page on a wide window (LabSidebar).
  sidebar?: ReactNode;
  // Over the window, outside the sidebar and the page, where the live
  // app portals its menus and dialogs. With them the window is
  // positioned, to be the block they are placed in.
  overlays?: ReactNode;
  // The page.
  children?: ReactNode;
}) {
  return (
    <AppShellView
      phone={window === "phone"}
      hasLocalHost={window === "desktop"}
      sidebar={sidebar}
      tabBar={<PhoneTabBarView active="/forest/inbox" updateReady={false} />}
      overlays={overlays}
      className={cn("h-full", overlays !== undefined && "relative")}
    >
      {children}
    </AppShellView>
  );
}
