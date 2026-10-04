// Contact sheet entry: the fixture bridge with Village life on, so the
// faces show, then the sheet (villagerSheet.tsx). The bridge owns
// window.api before any renderer module evaluates, as in
// main.tsx.
import "./villager-icons.css";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";

applyPose();
installFakeHostBridge({ villageLife: true });

void import("./villagerSheet");
