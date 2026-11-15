// Fake host entry: the fixture bridge, then the shared boot on its api.
// oxlint-disable-next-line import/no-unassigned-import -- poses the viewer's OS before the app reads it
import "./viewer";
import { bootFakeHost } from "./boot";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";
import { exposeToLab } from "@/lib/runtime/labHandle";
import { pageRoot } from "@/lib/themeRoot";
import { viewerOs } from "@shigomori/ui/lib/platform.ts";

// The shared theme pose (pose.ts). This entry also answers
// ?peers (bridge.ts) and ?to=/account, the memory-router route
// applied after mount. A window posed on Windows (viewer.ts) has its
// sidebar on the right, as a Windows window's is.
applyPose();
if (viewerOs === "windows") pageRoot().dataset["sidebarSide"] = "right";

const page = installFakeHostBridge();
exposeToLab(page.api);
bootFakeHost(page);
