// Fake host entry. Same rule as web/main.tsx: the bridge must own window.api
// before any renderer module evaluates (queryKeys and the remote
// registry read it at module scope), so the app boots via dynamic
// import.
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";

// The shared theme pose (pose.ts). This entry also answers
// ?peers (bridge.ts) and ?to=/account, the memory-router route
// applied after mount.
applyPose();

const links = installFakeHostBridge();

void import("./boot").then(({ bootFakeHost }) => bootFakeHost(links));
