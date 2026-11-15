// Fake host entry: the fixture bridge, then the shared boot on its api.
// First, to pose the viewer's OS before the app reads it.
import { posedOnWindows } from "./viewer";
import { bootFakeHost } from "./boot";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";
import { exposeToLab } from "@/lib/runtime/labHandle";
import { pageRoot } from "@/lib/themeRoot";

// The shared theme pose (pose.ts). This entry also answers
// ?peers (bridge.ts) and ?to=/account, the memory-router route
// applied after mount. A window posed on Windows (viewer.ts) has its
// sidebar on the right, as a Windows window's is.
applyPose();
if (posedOnWindows) pageRoot().dataset["sidebarSide"] = "right";

const page = installFakeHostBridge();
exposeToLab(page.api);
bootFakeHost(page);
