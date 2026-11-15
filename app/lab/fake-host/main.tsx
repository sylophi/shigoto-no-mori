// Fake host entry: the fixture bridge, then the shared boot on its api.
// oxlint-disable-next-line import/no-unassigned-import -- poses the viewer's OS before the app reads it
import "./viewer";
import { bootFakeHost } from "./boot";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";
import { exposeToLab } from "@/lib/runtime/labHandle";

// The shared theme pose (pose.ts). This entry also answers
// ?peers (bridge.ts) and ?to=/account, the memory-router route
// applied after mount.
applyPose();

const page = installFakeHostBridge();
exposeToLab(page.api);
bootFakeHost(page);
