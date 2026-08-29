// Web-shell lab entry: the REAL web app tree (web/app/boot) on the
// fixture bridge, with this page posing as an enrolled browser device.
// Same pose params as the desktop lab entry (?theme, ?doubutsu,
// ?peers), minus ?to: the route comes from the path itself, since the web router
// rides real browser history.
import { applyPose } from "./pose";
import { installWebBridge } from "./webInstall";

applyPose();

installWebBridge();

void import("../web/app/boot");
