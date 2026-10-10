// The desktop window's entry: window.api over the window's links to its
// shell and its host (lib/runtime/desktop.ts), on the window's runtime,
// then the shared boot with the Electron flavor of Clerk and a memory
// history (a window has no address bar) starting on the page the shell
// opened the window on. window.api must be in place
// before any renderer module evaluates, since several read it at module
// scope, so the boot comes in through a dynamic import (a static one
// would hoist above the install).
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { disposeWithPage, startClient } from "./lib/runtime/client";
import * as Desktop from "./lib/runtime/desktop";

async function installApi() {
  const bridge = window.electronBridge;
  if (bridge === undefined) throw new Error("the preload's bridge is missing");
  const { requestShellPort: _, route, ...facts } = bridge;
  const client = await startClient(Desktop.layer(bridge));
  disposeWithPage(client);
  // The device id is the host's, read from its store.
  const { deviceId } = await client.api.window.hostAddress();
  window.api = { ...facts, deviceId, ...client.api };
  return { links: client.links, route };
}

void installApi().then(async ({ links, route }) => {
  const { bootApp } = await import("./boot");
  const router = bootApp({
    ClerkProvider,
    history: createMemoryHistory({ initialEntries: [route] }),
    links,
  });
  // The page it shows, which a quit remembers it on.
  router.subscribe("onResolved", ({ toLocation }) => {
    void window.api.window.showing({ route: toLocation.href });
  });
});
