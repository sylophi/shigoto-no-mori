// Contact sheet entry: the fixture bridge with Village life on, so the
// faces show, then the sheet (villagerSheet.tsx) on its api. The sheet
// reads the pose as it evaluates, so it comes in after applyPose.
import "./villager-icons.css";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";

applyPose();
const { api } = installFakeHostBridge({ villageLife: true });
void import("./villagerSheet").then(({ mountVillagerSheet }) =>
  mountVillagerSheet(api),
);
