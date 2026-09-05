// The browser page's entry, the twin of the desktop's index.html +
// preload: install the binding on window.api, then boot the renderer.
// Order is the whole point of this file: the bridge must sit on
// window.api before ANY renderer module evaluates, because several of
// them read the bridge at module scope (queryKeys' device id, the
// remote registry's local facts). A static import of the boot would
// hoist above the install call, so it goes through a dynamic import.
import { installWebBridge } from "./preload";

installWebBridge();

void import("./boot");
