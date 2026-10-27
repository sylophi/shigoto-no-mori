// The browser page's entry, the twin of the desktop's index.html +
// preload: make the binding, then boot the renderer on its api.
import { listenForReactGrab } from "@/lib/reactGrab";
import { bootWeb } from "./boot";
import { installWebBridge } from "./preload";
import { exposeToLab } from "@/lib/runtime/labHandle";
import { log } from "@shared/log";

listenForReactGrab();
installWebBridge().then(
  (page) => {
    if (import.meta.env.DEV) exposeToLab(page.api);
    bootWeb(page);
  },
  (error: unknown) => log.error("[boot] the page's bridge:", error),
);
