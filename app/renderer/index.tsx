// The desktop window's entry: the shared boot with the Electron flavor
// of Clerk and a memory history (a window has no address bar). The
// preload script has already put window.api in place.
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { bootApp } from "./boot";

bootApp({
  ClerkProvider,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
