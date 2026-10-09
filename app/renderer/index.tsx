// The desktop window's entry: window.api over the window's links to its
// shell and its host (electronApi.ts), then the shared boot with the
// Electron flavor of Clerk and a memory history (a window has no
// address bar). window.api must be in place before any renderer module
// evaluates, since several read it at module scope, so the boot comes
// in through a dynamic import (a static one would hoist above the
// install).
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { installElectronApi } from "./electronApi";

void installElectronApi()
  .then(() => import("./boot"))
  .then(({ bootApp }) =>
    bootApp({
      ClerkProvider,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    }),
  );
