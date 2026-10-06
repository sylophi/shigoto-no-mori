import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  ProjectScopedPayloadSchema,
  ReadWorktreeDataPayloadSchema,
  ShigomoriWorktreeDataSchema,
  StoredShigomoriConfigSchema,
  WriteShigomoriPayloadSchema,
  WriteWorktreeDataPayloadSchema,
  WriteWorktreeDescriptionPayloadSchema,
} from "@shared/schemas";

export const shigomoriContract = defineContract("host", {
  read: invoke(
    "shigomori:read",
    ProjectScopedPayloadSchema,
    StoredShigomoriConfigSchema.nullable(),
    { remote: true, gated: false },
  ),
  write: invoke("shigomori:write", WriteShigomoriPayloadSchema, z.void(), {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  }),
  worktreeDataRead: invoke(
    "worktreeData:read",
    ReadWorktreeDataPayloadSchema,
    ShigomoriWorktreeDataSchema.nullable(),
    { remote: true, gated: false },
  ),
  worktreeDataWrite: invoke(
    "worktreeData:write",
    WriteWorktreeDataPayloadSchema,
    z.void(),
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // A worktree's title and description, carried onto its copy here by
  // the device that sent it or runs its mirror
  // (host/lib/sync/worktreeDescription.ts).
  worktreeDataDescribe: invoke(
    "worktreeData:describe",
    WriteWorktreeDescriptionPayloadSchema,
    z.void(),
    { remote: true, gated: true, invitable: "copy" },
  ),
});
