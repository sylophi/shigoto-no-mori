// Contact sheet entry: the fixture bridge with Village life on, so the
// faces show, then the sheet (villagerSheet.tsx) on its api.
import "./villager-icons.css";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";
import { mountVillagerSheet } from "./villagerSheet";

applyPose();
mountVillagerSheet(installFakeHostBridge({ villageLife: true }).api);
