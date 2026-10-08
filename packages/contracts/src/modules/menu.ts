import { defineContract, invoke } from "../contract.ts";
import {
  SetLaunchToolsEnabledPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const menuContract = defineContract(
  "menu",
  "client",
  invoke(
    "setLaunchToolsEnabled",
    SetLaunchToolsEnabledPayloadSchema,
    VoidSchema,
  ),
);
