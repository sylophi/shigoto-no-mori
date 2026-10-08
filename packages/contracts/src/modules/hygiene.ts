import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  ProjectScopedPayloadSchema,
  WorktreeDiskUsageSchema,
  WorktreeHygieneSchema,
  WorktreeScopedPayloadSchema,
} from "../schemas/index.ts";

export const hygieneContract = defineContract(
  "hygiene",
  "host",
  // Fast, all-git: safe to await before the tidy list renders.
  invoke(
    "list",
    ProjectScopedPayloadSchema,
    Schema.Array(WorktreeHygieneSchema),
    { remote: true, gated: false },
  ),
  // Slow, per-worktree: the renderer fires one of these per row so each
  // size lands independently instead of the page waiting on the total.
  invoke("diskUsage", WorktreeScopedPayloadSchema, WorktreeDiskUsageSchema, {
    remote: true,
    gated: false,
  }),
);
