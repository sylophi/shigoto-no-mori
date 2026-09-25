import { z } from "zod";
import { broadcast, defineContract } from "@shared/ipc/contract";

export const navContract = defineContract("client", {
  openSettings: broadcast("nav:openSettings", z.void()),
  launchById: broadcast("launch:byId", z.string()),
});
