import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  PathPayloadSchema,
  ShellOpenExternalPayloadSchema,
} from "@shared/schemas";

export const shellContract = {
  openPath: invoke("shell:openPath", PathPayloadSchema, z.void()),
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
