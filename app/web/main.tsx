// The browser page's entry, the twin of the desktop's index.html +
// preload: make the binding, then boot the renderer on its api.
import { bootWeb } from "./boot";
import { installWebBridge } from "./preload";

bootWeb(installWebBridge());
