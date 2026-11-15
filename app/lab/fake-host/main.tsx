// Fake host entry: the fixture bridge, then the shared boot on its api.
import { bootFakeHost } from "./boot";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";
import { exposeToLab } from "@/lib/runtime/labHandle";
import { pageRoot } from "@/lib/themeRoot";

// The shared theme pose (pose.ts). This entry also answers
// ?peers (bridge.ts), ?to=/account, the memory-router route
// applied after mount, and ?sidebar=right, a Windows window's sidebar.
applyPose();
if (new URLSearchParams(location.search).get("sidebar") === "right") {
  pageRoot().dataset["sidebarSide"] = "right";
}

const page = installFakeHostBridge();
exposeToLab(page.api);
bootFakeHost(page);
