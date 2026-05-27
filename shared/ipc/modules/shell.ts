import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
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

const client = buildClient(shellContract);

export const shell = {
  openPath: (path: string) => client.openPath({ path }),
  openExternal: (url: string) => client.openExternal({ url }),
  showItemInFolder: (path: string) => client.showItemInFolder({ path }),
} as const;
