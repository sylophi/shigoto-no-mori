// The browser page's entry, the twin of the desktop's index.html +
// preload: make the binding, then boot the renderer on its api.
import { bootWeb } from "./boot";
import { installWebBridge } from "./preload";
import { exposeToLab } from "@/lib/runtime/labHandle";

const page = installWebBridge();
if (import.meta.env.DEV) exposeToLab(page.api);
bootWeb(page);
