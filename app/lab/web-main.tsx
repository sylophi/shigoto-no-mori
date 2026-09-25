// Web-shell lab entry: the REAL web boot (web/boot) on the fixture
// bridge, with this page posing as an enrolled browser device.
// Same pose params as the desktop lab entry (?theme, ?doubutsu,
// ?peers), minus ?to: the route comes from the path itself, since the web router
// rides real browser history.
import { applyPose } from "./pose";
import { installLabBridge } from "./bridge";

applyPose();

// Lab stand-in for web/preload.ts: the web page boots on the fixture
// window.api instead of the real hub-backed bridge.
installLabBridge({ webShell: true });

void import("../web/boot");
