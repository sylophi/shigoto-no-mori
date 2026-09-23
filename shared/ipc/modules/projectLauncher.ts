import { Schema } from "effect";
import { broadcast, defineContract } from "@shared/ipc/contract";

export const projectLauncherContract = defineContract("client", {
  toggle: broadcast("projectLauncher:toggle", Schema.Undefined),
  addProject: broadcast("projectLauncher:addProject", Schema.Undefined),
});
