import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { broadcast } from "@shared/ipc/contract";

export const navContract = {
  openSettings: broadcast("nav:openSettings", z.void()),
  launchById: broadcast("launch:byId", z.string()),
} as const;

export type NavContract = typeof navContract;

const client = buildClient(navContract);

export const nav = {
  onOpenSettings: client.openSettings,
  onLaunchById: client.launchById,
} as const;
