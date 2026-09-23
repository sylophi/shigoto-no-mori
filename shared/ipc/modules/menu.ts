import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";
import { SetLaunchToolsEnabledPayloadSchema } from "@shared/schemas";

export const menuContract = defineContract("client", {
  setLaunchToolsEnabled: invoke(
    "menu:setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    Schema.Undefined,
  ),
});
