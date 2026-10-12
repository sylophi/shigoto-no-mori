// The desktop window's entry: the page's api over the window's links to
// its shell and its host (lib/runtime/desktop.ts), on the window's
// runtime, then the shared boot with the Electron flavor of Clerk and a
// memory history (a window has no address bar) starting on the page the
// shell opened the window on.
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { mountWindow, startApp } from "./boot";
import { disposeWithPage, startClient } from "./lib/runtime/client";
import type { RendererApi } from "./lib/runtime/pageApi";
import { pageRoot } from "./lib/themeRoot";
import { exposeToLab } from "./lib/runtime/labHandle";
import * as Desktop from "./lib/runtime/desktop";

async function boot() {
  const bridge = window.electronBridge;
  if (bridge === undefined) throw new Error("the preload's bridge is missing");
  const { requestShellPort: _, route, isLab, ...facts } = bridge;
  const client = await startClient(Desktop.layer(bridge));
  disposeWithPage(client);
  // The device id is the host's, read from its store.
  const { deviceId } = await client.api.window.hostAddress();
  const api: RendererApi = { ...facts, deviceId, ...client.api };
  if (facts.isDev || isLab) exposeToLab(api);
  const router = mountWindow(startApp({ api, links: client.links }), {
    element: pageRoot(),
    ClerkProvider,
    history: createMemoryHistory({ initialEntries: [route] }),
  });
  // The page it shows, which a quit remembers it on.
  router.subscribe("onResolved", ({ toLocation }) => {
    void api.window.showing({ route: toLocation.href });
  });
}

void boot();
