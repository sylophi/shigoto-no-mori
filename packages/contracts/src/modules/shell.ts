import { defineContract, invoke } from "../contract.ts";
import {
  PathPayloadSchema,
  ShellOpenExternalPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const shellContract = defineContract(
  "shell",
  "client",
  invoke("openExternal", ShellOpenExternalPayloadSchema, VoidSchema),
  invoke("showItemInFolder", PathPayloadSchema, VoidSchema),
);
