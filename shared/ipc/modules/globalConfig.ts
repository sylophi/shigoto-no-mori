import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  StoredGlobalConfigSchema,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";

export const globalConfigContract = {
  read: invoke("globalConfig:read", z.void(), StoredGlobalConfigSchema),
  write: invoke("globalConfig:write", WriteGlobalConfigPayloadSchema, z.void()),
} as const;

export type GlobalConfigContract = typeof globalConfigContract;
