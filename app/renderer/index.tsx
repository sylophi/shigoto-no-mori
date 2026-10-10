// The desktop window's entry: window.api over the window's links to its
// shell and its host (lib/runtime/desktop.ts), on the window's runtime,
// then the shared boot with the Electron flavor of Clerk and a memory
// history (a window has no address bar). window.api must be in place
// before any renderer module evaluates, since several read it at module
// scope, so the boot comes in through a dynamic import (a static one
// would hoist above the install).
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { startClient } from "./lib/runtime/client";
import * as Desktop from "./lib/runtime/desktop";

async function installApi(): Promise<void> {
  const bridge = window.electronBridge;
  if (bridge === undefined) throw new Error("the preload's bridge is missing");
  const { requestShellPort: _, ...facts } = bridge;
  const api = await startClient(Desktop.layer(bridge));
  // The device id is the host's, read from its store.
  const { deviceId } = await api.window.hostAddress();
  window.api = { ...facts, deviceId, ...api };
}

void installApi()
  .then(() => import("./boot"))
  .then(({ bootApp }) =>
    bootApp({
      ClerkProvider,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    }),
  );
