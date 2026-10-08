import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  ProjectScopedPayloadSchema,
  ReadWorktreeDataPayloadSchema,
  ShigomoriWorktreeDataSchema,
  StoredShigomoriConfigSchema,
  VoidSchema,
  WriteShigomoriPayloadSchema,
  WriteWorktreeDataPayloadSchema,
  WriteWorktreeDescriptionPayloadSchema,
} from "../schemas/index.ts";

export const shigomoriContract = defineContract("host", {
  read: invoke(
    "shigomori:read",
    ProjectScopedPayloadSchema,
    Schema.NullOr(StoredShigomoriConfigSchema),
    { remote: true, gated: false },
  ),
  write: invoke("shigomori:write", WriteShigomoriPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  }),
  worktreeDataRead: invoke(
    "worktreeData:read",
    ReadWorktreeDataPayloadSchema,
    Schema.NullOr(ShigomoriWorktreeDataSchema),
    { remote: true, gated: false },
  ),
  worktreeDataWrite: invoke(
    "worktreeData:write",
    WriteWorktreeDataPayloadSchema,
    VoidSchema,
    { tracksProjectUsage: true, remote: true, gated: true },
  ),
  // A worktree's title and description, carried onto its copy here by
  // the device that sent it or runs its mirror
  // (host/lib/sync/worktreeDescription.ts).
  worktreeDataDescribe: invoke(
    "worktreeData:describe",
    WriteWorktreeDescriptionPayloadSchema,
    VoidSchema,
    { remote: true, gated: true, invitable: "copy" },
  ),
});
