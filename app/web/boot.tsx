// The browser tab's boot: the shared renderer boot with the plain
// @clerk/react provider and real browser history. The twin of
// renderer/index.tsx, which is the desktop window's.
import { ClerkProvider } from "@clerk/react";
import { createBrowserHistory } from "@tanstack/react-router";
import { mountWindow, startApp } from "@/boot";
import { pageRoot } from "@/lib/themeRoot";
import type { ClientLinks } from "@/lib/runtime/ClientLinks";

export function bootWeb(links: ClientLinks["Service"]): void {
  mountWindow(startApp({ links }), {
    element: pageRoot(),
    ClerkProvider,
    history: createBrowserHistory(),
  });
}
