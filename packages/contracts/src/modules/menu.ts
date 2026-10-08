import { defineContract, invoke } from "../contract.ts";
import {
  SetLaunchToolsEnabledPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const menuContract = defineContract("client", {
  setLaunchToolsEnabled: invoke(
    "menu:setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    VoidSchema,
  ),
});
