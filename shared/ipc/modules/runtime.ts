import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { invoke } from "@shared/ipc/contract";
import { RuntimeInfoSchema, SetThemePayloadSchema } from "@shared/schemas";
import type { Theme } from "@shared/schemas";

export const runtimeContract = {
  info: invoke("runtime:info", z.void(), RuntimeInfoSchema),
  setTheme: invoke("runtime:setTheme", SetThemePayloadSchema, z.void()),
  nuke: invoke("runtime:nuke", z.void(), z.void()),
} as const;

export type RuntimeContract = typeof runtimeContract;

const client = buildClient(runtimeContract);

export const runtime = {
  info: () => client.info(),
  setTheme: (theme: Theme) => client.setTheme({ theme }),
  nuke: () => client.nuke(),
} as const;
