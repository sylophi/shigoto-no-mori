import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  StoredGlobalConfigSchema,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";

export const globalConfigContract = defineContract("host", {
  read: invoke("globalConfig:read", z.void(), StoredGlobalConfigSchema),
  write: invoke("globalConfig:write", WriteGlobalConfigPayloadSchema, z.void()),
});
