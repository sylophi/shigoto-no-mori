import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  ShellOpenExternalPayloadSchema,
  ShellPathPayloadSchema,
} from "@shared/schemas";

export const shellContract = {
  openPath: invoke("shell:openPath", ShellPathPayloadSchema, z.void()),
  openExternal: invoke(
    "shell:openExternal",
    ShellOpenExternalPayloadSchema,
    z.void(),
  ),
  showItemInFolder: invoke(
    "shell:showItemInFolder",
    ShellPathPayloadSchema,
    z.void(),
  ),
} as const;

export type ShellContract = typeof shellContract;
