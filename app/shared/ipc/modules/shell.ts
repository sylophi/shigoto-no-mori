import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  PathPayloadSchema,
  ShellOpenExternalPayloadSchema,
  VoidSchema,
} from "@shared/schemas";

export const shellContract = defineContract("client", {
  openExternal: invoke(
    "shell:openExternal",
    ShellOpenExternalPayloadSchema,
    VoidSchema,
  ),
  showItemInFolder: invoke(
    "shell:showItemInFolder",
    PathPayloadSchema,
    z.void(),
  ),
});
