// The desktop window's boot: the shared boot with the Electron flavor
// of Clerk and a memory history (a window has no address bar).
// Reached through a dynamic import from index.tsx, after window.api is
// in place.
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { bootApp } from "./boot";

bootApp({
  ClerkProvider,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
