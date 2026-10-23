// The marketing site's live frames: desktop windows of the real app over
// the fixture world, each mounted in-process into an element of the
// site's page, all of them on one bridge and one client. The frame's
// element is the window's theme root, and the page sets its theme.
import { createMemoryHistory } from "@tanstack/react-router";
import { mountWindow, startApp } from "@/boot";
import { ClerkProvider } from "./clerkStub";
import { installFakeHostBridge } from "./bridge";

let started: ReturnType<typeof start> | undefined;

function start() {
  // Every visit starts on the client settings the scenes draw (the
  // sidebar's inbox), as pose.ts seeds the fake host's, and with no last
  // version, so a fixture version that moved brings no update toast.
  localStorage.setItem(
    "sm.fakeHost.clientConfig",
    JSON.stringify({ sidebarView: "inbox" }),
  );
  localStorage.removeItem("shigomori.lastVersion");
  return startApp(installFakeHostBridge({ dev: false }));
}

// Mounts a window on `route` into `element`, in place of what it held.
export async function mountFrame(
  element: HTMLElement,
  route: string,
): Promise<void> {
  started ??= start();
  const client = started;
  element.replaceChildren();
  const router = mountWindow(client, {
    element,
    ClerkProvider,
    history: createMemoryHistory({ initialEntries: [route] }),
    themeFromRoot: true,
  });
  // The router takes the page to its top after each navigation, which a
  // window of its own never notices (its panes scroll, not the page).
  // A frame's page stays where the visitor had it.
  let pageScroll = 0;
  router.subscribe("onBeforeNavigate", () => {
    pageScroll = window.scrollY;
  });
  router.subscribe("onRendered", () => {
    window.scrollTo({ top: pageScroll, behavior: "instant" });
  });
}
