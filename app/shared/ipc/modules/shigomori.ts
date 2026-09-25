import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  ProjectScopedPayloadSchema,
  ReadWorktreeDataPayloadSchema,
  ShigomoriWorktreeDataSchema,
  StoredShigomoriConfigSchema,
  WriteShigomoriPayloadSchema,
  WriteWorktreeDataPayloadSchema,
} from "@shared/schemas";

export const shigomoriContract = defineContract("host", {
  read: invoke(
    "shigomori:read",
    ProjectScopedPayloadSchema,
    StoredShigomoriConfigSchema.nullable(),
    { remote: true, mutating: false },
  ),
  write: invoke("shigomori:write", WriteShigomoriPayloadSchema, z.void(), {
    tracksProjectUsage: true,
    remote: true,
    mutating: true,
  }),
  worktreeDataRead: invoke(
    "worktreeData:read",
    ReadWorktreeDataPayloadSchema,
    ShigomoriWorktreeDataSchema.nullable(),
    { remote: true, mutating: false },
  ),
  worktreeDataWrite: invoke(
    "worktreeData:write",
    WriteWorktreeDataPayloadSchema,
    z.void(),
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
});
