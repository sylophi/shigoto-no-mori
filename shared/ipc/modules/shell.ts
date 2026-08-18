import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  PathPayloadSchema,
  ShellOpenExternalPayloadSchema,
} from "@shared/schemas";

export const shellContract = {
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
} as const;

export type ShellContract = typeof shellContract;
