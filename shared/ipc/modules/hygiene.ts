import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  ProjectScopedPayloadSchema,
  WorktreeDiskUsageSchema,
  WorktreeHygieneSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

export const hygieneContract = defineContract("host", {
  // Fast, all-git: safe to await before the tidy list renders.
  list: invoke(
    "hygiene:list",
    ProjectScopedPayloadSchema,
    z.array(WorktreeHygieneSchema),
    { remote: true },
  ),
  // Slow, per-worktree: the renderer fires one of these per row so each
  // size lands independently instead of the page waiting on the total.
  diskUsage: invoke(
    "hygiene:diskUsage",
    WorktreeScopedPayloadSchema,
    WorktreeDiskUsageSchema,
    { remote: true },
  ),
});
