import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  GlobalConfigSchema,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";

export const globalConfigContract = {
  read: invoke("globalConfig:read", z.void(), GlobalConfigSchema),
  write: invoke("globalConfig:write", WriteGlobalConfigPayloadSchema, z.void()),
} as const;

export type GlobalConfigContract = typeof globalConfigContract;
