// Contact sheet entry: the fixture bridge with Village life on, so the
// faces show, then the sheet (villagerSheet.tsx). The bridge owns
// window.api before any renderer module evaluates, as in lab/main.tsx.
import "./villager-icons.css";
import { installLabBridge } from "./bridge";
import { applyPose } from "./pose";

applyPose();
installLabBridge({ villageLife: true });

void import("./villagerSheet");
