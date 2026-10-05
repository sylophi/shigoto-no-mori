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

// The shared boot script (web/public/boot-theme.js, loaded here for
// its theme half) also stamps the web shell's phone layout by width.
// This entry poses as the desktop, which never takes that layout, so
// the stamp comes off before the app reads it.
delete document.documentElement.dataset["layout"];

installFakeHostBridge();

void import("./boot");
