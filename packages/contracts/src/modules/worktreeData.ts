import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  ReadWorktreeDataPayloadSchema,
  ShigomoriWorktreeDataSchema,
  VoidSchema,
  WriteWorktreeDataPayloadSchema,
  WriteWorktreeDescriptionPayloadSchema,
} from "../schemas/index.ts";

// A worktree's own data in its project's .shigomori.json: its ports,
// and its title and description.
export const worktreeDataContract = defineContract(
  "worktreeData",
  "host",
  // A mirror into this device reads its copy's description here
  // (host/lib/sync/worktreeDescription.ts), invited past the sharing
  // switch.
  invoke(
    "read",
    ReadWorktreeDataPayloadSchema,
    Schema.NullOr(ShigomoriWorktreeDataSchema),
    { remote: true, gated: false, invitable: "copy" },
  ),
  invoke("write", WriteWorktreeDataPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  // A worktree's title and description, carried onto its copy here by
  // the device that sent it or runs its mirror
  // (host/lib/sync/worktreeDescription.ts).
  invoke("describe", WriteWorktreeDescriptionPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
    invitable: "copy",
  }),
);
