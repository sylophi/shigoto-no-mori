import { z } from "zod";
import { broadcast } from "@shared/ipc/contract";

export const navContract = {
  openSettings: broadcast("nav:openSettings", z.void()),
  openForest: broadcast("nav:openForest", z.void()),
  launchById: broadcast("launch:byId", z.string()),
} as const;

export type NavContract = typeof navContract;
