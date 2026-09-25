import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  PathPayloadSchema,
  ShellOpenExternalPayloadSchema,
} from "@shared/schemas";

export const shellContract = defineContract("client", {
  openExternal: invoke(
    "shell:openExternal",
    ShellOpenExternalPayloadSchema,
    z.void(),
  ),
  showItemInFolder: invoke(
    "shell:showItemInFolder",
    PathPayloadSchema,
    z.void(),
  ),
});
