import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  ProjectScopedPayloadSchema,
  WorktreeDiskUsageSchema,
  WorktreeHygieneSchema,
  WorktreeScopedPayloadSchema,
} from "../schemas/index.ts";

export const hygieneContract = defineContract("host", {
  // Fast, all-git: safe to await before the tidy list renders.
  list: invoke(
    "hygiene:list",
    ProjectScopedPayloadSchema,
    Schema.Array(WorktreeHygieneSchema),
    { remote: true, gated: false },
  ),
  // Slow, per-worktree: the renderer fires one of these per row so each
  // size lands independently instead of the page waiting on the total.
  diskUsage: invoke(
    "hygiene:diskUsage",
    WorktreeScopedPayloadSchema,
    WorktreeDiskUsageSchema,
    { remote: true, gated: false },
  ),
});
