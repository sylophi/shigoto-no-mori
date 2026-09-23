import { Schema } from "effect";
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
    Schema.NullOr(StoredShigomoriConfigSchema),
    { remote: true, mutating: false },
  ),
  write: invoke(
    "shigomori:write",
    WriteShigomoriPayloadSchema,
    Schema.Undefined,
    {
      tracksProjectUsage: true,
      remote: true,
      mutating: true,
    },
  ),
  worktreeDataRead: invoke(
    "worktreeData:read",
    ReadWorktreeDataPayloadSchema,
    Schema.NullOr(ShigomoriWorktreeDataSchema),
    { remote: true, mutating: false },
  ),
  worktreeDataWrite: invoke(
    "worktreeData:write",
    WriteWorktreeDataPayloadSchema,
    Schema.Undefined,
    { tracksProjectUsage: true, remote: true, mutating: true },
  ),
});
