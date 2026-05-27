import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { invoke } from "@shared/ipc/contract";
import { SetLaunchToolsEnabledPayloadSchema } from "@shared/schemas";
import type { LaunchToolMenuEntry } from "@shared/schemas";

export const menuContract = {
  setLaunchToolsEnabled: invoke(
    "menu:setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    z.void(),
  ),
} as const;

export type MenuContract = typeof menuContract;

const client = buildClient(menuContract);

export const menu = {
  setLaunchToolsEnabled: (enabled: boolean, entries?: LaunchToolMenuEntry[]) =>
    client.setLaunchToolsEnabled({ enabled, entries }),
} as const;
