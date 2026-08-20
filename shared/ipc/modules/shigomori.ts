import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  ProjectScopedPayloadSchema,
  ReadWorktreeDataPayloadSchema,
  ShigomoriWorktreeDataSchema,
  StoredShigomoriConfigSchema,
  WriteShigomoriPayloadSchema,
  WriteWorktreeDataPayloadSchema,
} from "@shared/schemas";

export const shigomoriContract = {
  read: invoke(
    "shigomori:read",
    ProjectScopedPayloadSchema,
    StoredShigomoriConfigSchema.nullable(),
  ),
  write: invoke("shigomori:write", WriteShigomoriPayloadSchema, z.void(), {
    tracksProjectUsage: true,
  }),
  worktreeDataRead: invoke(
    "worktreeData:read",
    ReadWorktreeDataPayloadSchema,
    ShigomoriWorktreeDataSchema.nullable(),
  ),
  worktreeDataWrite: invoke(
    "worktreeData:write",
    WriteWorktreeDataPayloadSchema,
    z.void(),
    { tracksProjectUsage: true },
  ),
} as const;
