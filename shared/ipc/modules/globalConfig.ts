import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { invoke } from "@shared/ipc/contract";
import {
  GlobalConfigSchema,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";
import type { GlobalConfig } from "@shared/schemas";

export const globalConfigContract = {
  read: invoke("globalConfig:read", z.void(), GlobalConfigSchema),
  write: invoke("globalConfig:write", WriteGlobalConfigPayloadSchema, z.void()),
} as const;

export type GlobalConfigContract = typeof globalConfigContract;

const client = buildClient(globalConfigContract);

export const globalConfig = {
  read: () => client.read(),
  write: (config: GlobalConfig) => client.write({ config }),
} as const;
