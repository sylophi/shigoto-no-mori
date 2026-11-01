// The browser tab's boot: the shared renderer boot with the plain
// @clerk/react provider and real browser history. The twin of
// renderer/index.tsx, which is the desktop window's.
import { ClerkProvider } from "@clerk/react";
import { createBrowserHistory } from "@tanstack/react-router";
import { mountWindow, startApp } from "@/boot";
import { pageRoot } from "@/lib/themeRoot";
import type { RendererApi } from "@/lib/runtime/pageApi";

export function bootWeb({ api }: { api: RendererApi }): void {
  mountWindow(startApp({ api }), {
    element: pageRoot(),
    ClerkProvider,
    history: createBrowserHistory(),
  });
}
