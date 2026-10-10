// The app's window around a sidebar and a page, for composing a whole
// window out of views: the desktop app's (the sidebar column at its
// default width, the resize edge, the page in the main zone under the
// title-bar strip) or the web app's on a phone (the page over the tab
// bar). It fills the box it is given, which a scene's frame sizes as
// the window it draws.
import type { ReactNode } from "react";
import { AppShellView } from "@shigomori/ui/views/AppShellView.tsx";
import { PhoneTabBarView } from "@shigomori/ui/views/PhoneTabBarView.tsx";
import {
  MODAL_BACKDROP,
  ModalBox,
} from "@shigomori/ui/primitives/modal-shell.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

// A whole window a scene can draw: the desktop app's, or the web app
// on a phone.
export type SceneWindow = "desktop" | "phone";

// What the app's stylesheet reads off <html> to lay a window out
// (data-shell, data-layout), for whoever stands in for <html> around a
// scene: the desktop window's page is transparent under the sidebar
// and its headers sit on the traffic lights' line, and the phone takes
// the phone layout.
export function windowAttributes(window: SceneWindow | undefined): {
  "data-shell"?: "desktop";
  "data-layout"?: "phone";
} {
  if (window === "desktop") return { "data-shell": "desktop" };
  if (window === "phone") return { "data-layout": "phone" };
  return {};
}

export function SceneWindowFrame({
  window = "desktop",
  sidebar,
  backBar,
  pathname = "/forest/inbox",
  overlays,
  children,
}: {
  window?: SceneWindow;
  // Beside the page on a wide window.
  sidebar?: ReactNode;
  // Over a page stacked on the forest, on a phone (PhoneBackBarView).
  backBar?: ReactNode;
  // The page the phone's tab bar lights.
  pathname?: string;
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
      backBar={backBar}
      tabBar={
        <PhoneTabBarView
          pathname={pathname}
          view="inbox"
          updateReady={false}
          onNavigate={() => {}}
        />
      }
      overlays={overlays}
      className={cn("h-full", overlays !== undefined && "relative")}
    >
      {children}
    </AppShellView>
  );
}

// A dialog over the window, drawn in place (a portal draws nothing on
// a server): the backdrop the live one hangs it from, and its box.
export function SceneDialog({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("absolute", MODAL_BACKDROP)}>
      <ModalBox className={className}>{children}</ModalBox>
    </div>
  );
}
