import { z } from "zod";
import { broadcast } from "@shared/ipc/contract";

export const projectLauncherContract = {
  toggle: broadcast("projectLauncher:toggle", z.void()),
  addProject: broadcast("projectLauncher:addProject", z.void()),
} as const;
