import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  ReadShigomoriPayloadSchema,
  ReadWorktreeDataPayloadSchema,
  ShigomoriConfigSchema,
  ShigomoriWorktreeDataSchema,
  WriteShigomoriPayloadSchema,
  WriteWorktreeDataPayloadSchema,
} from "@shared/schemas";

export const shigomoriContract = {
  read: invoke(
    "shigomori:read",
    ReadShigomoriPayloadSchema,
    ShigomoriConfigSchema.nullable(),
  ),
  write: invoke("shigomori:write", WriteShigomoriPayloadSchema, z.void()),
  worktreeDataRead: invoke(
    "worktreeData:read",
    ReadWorktreeDataPayloadSchema,
    ShigomoriWorktreeDataSchema.nullable(),
  ),
  worktreeDataWrite: invoke(
    "worktreeData:write",
    WriteWorktreeDataPayloadSchema,
    z.void(),
  ),
} as const;

export type ShigomoriContract = typeof shigomoriContract;
