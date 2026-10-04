// Web-shell fake host entry: the REAL web boot (web/boot) on the
// fixture bridge, with this page posing as an enrolled browser device.
// Same pose params as the desktop fake host entry (?theme, ?doubutsu,
// ?light, ?dark, ?peers), minus ?to: the route comes from the path
// itself, since the web router rides real browser history.
import { applyPose } from "./pose";
import { installFakeHostBridge } from "./bridge";

applyPose();

// Fake host stand-in for web/preload.ts: the web page boots on the fixture
// window.api instead of the real hub-backed bridge.
installFakeHostBridge({ webShell: true });

void import("../../web/boot");
