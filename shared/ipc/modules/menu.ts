import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import { SetLaunchToolsEnabledPayloadSchema } from "@shared/schemas";

export const menuContract = {
  setLaunchToolsEnabled: invoke(
    "menu:setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    z.void(),
  ),
} as const;

export type MenuContract = typeof menuContract;
