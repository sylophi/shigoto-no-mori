import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  PathPayloadSchema,
  ShellOpenExternalPayloadSchema,
} from "@shared/schemas";

export const shellContract = defineContract("client", {
  openExternal: invoke(
    "shell:openExternal",
    ShellOpenExternalPayloadSchema,
    Schema.Undefined,
  ),
  showItemInFolder: invoke(
    "shell:showItemInFolder",
    PathPayloadSchema,
    Schema.Undefined,
  ),
});
