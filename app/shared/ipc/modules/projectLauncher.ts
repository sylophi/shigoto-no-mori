import { z } from "zod";
import { broadcast, defineContract } from "@shared/ipc/contract";

export const projectLauncherContract = defineContract("client", {
  toggle: broadcast("projectLauncher:toggle", z.void()),
  addProject: broadcast("projectLauncher:addProject", z.void()),
});
