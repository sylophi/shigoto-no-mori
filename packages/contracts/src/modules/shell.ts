import { defineContract, invoke } from "../contract.ts";
import {
  PathPayloadSchema,
  ShellOpenExternalPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const shellContract = defineContract("client", {
  openExternal: invoke(
    "shell:openExternal",
    ShellOpenExternalPayloadSchema,
    VoidSchema,
  ),
  showItemInFolder: invoke(
    "shell:showItemInFolder",
    PathPayloadSchema,
    VoidSchema,
  ),
});
