import { defineContract, invoke } from "@shared/ipc/contract";
import {
  SetLaunchToolsEnabledPayloadSchema,
  VoidSchema,
} from "@shared/schemas";

export const menuContract = defineContract("client", {
  setLaunchToolsEnabled: invoke(
    "menu:setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    VoidSchema,
  ),
});
