import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  BranchListSchema,
  CloneProjectPayloadSchema,
  PathPayloadSchema,
  ProjectIconSchema,
  ProjectSchema,
  ProjectScopedPayloadSchema,
  RemoveProjectPayloadSchema,
  ReorderProjectsPayloadSchema,
  CarryOverCandidateSchema,
  CarryOverListingPayloadSchema,
  CarryOverStatSchema,
  CarryOverStatsPayloadSchema,
  WorktreeIncludeStatusSchema,
} from "@shared/schemas";

export const projectsContract = defineContract("host", {
  list: invoke("projects:list", z.void(), z.array(ProjectSchema), {
    remote: true,
    gated: false,
  }),
  add: invoke("projects:add", PathPayloadSchema, ProjectSchema, {
    remote: true,
    gated: true,
  }),
  // Runs for as long as the clone does. The wire has no per-call
  // timeout, and the device doing the clone uses its own credentials.
  clone: invoke("projects:clone", CloneProjectPayloadSchema, ProjectSchema, {
    remote: true,
    gated: true,
  }),
  remove: invoke("projects:remove", RemoveProjectPayloadSchema, z.void(), {
    remote: true,
    gated: true,
  }),
  reorder: invoke("projects:reorder", ReorderProjectsPayloadSchema, z.void(), {
    remote: true,
    gated: true,
  }),
  // Emitted after an action bumps a project's usage so the renderer can
  // refresh its usage-sorted sidebar list.
  usageBumped: broadcast("projects:usageBumped", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  defaultBranch: invoke(
    "projects:defaultBranch",
    ProjectScopedPayloadSchema,
    z.string(),
    { remote: true, gated: false },
  ),
  // The remote another device would clone to get this repo, or null
  // when it has none. Credentials never ride along (shared/cloneUrl.ts).
  cloneUrl: invoke(
    "projects:cloneUrl",
    ProjectScopedPayloadSchema,
    z.string().nullable(),
    { remote: true, gated: false },
  ),
  listBranches: invoke(
    "projects:listBranches",
    ProjectScopedPayloadSchema,
    BranchListSchema,
    { remote: true, gated: false },
  ),
  pickWorktreeName: invoke(
    "projects:pickWorktreeName",
    ProjectScopedPayloadSchema,
    z.string(),
    { remote: true, gated: false },
  ),
  worktreeIncludeStatus: invoke(
    "projects:worktreeIncludeStatus",
    ProjectScopedPayloadSchema,
    WorktreeIncludeStatusSchema,
    { remote: true, gated: false },
  ),
  // Named for its first caller. The leave-out preset's picker reads it
  // too, on every device holding the repo, so the name stays for the
  // peers that know it.
  carryOverListing: invoke(
    "projects:carryOverListing",
    CarryOverListingPayloadSchema,
    z.array(CarryOverCandidateSchema),
    { remote: true, gated: false },
  ),
  carryOverStats: invoke(
    "projects:carryOverStats",
    CarryOverStatsPayloadSchema,
    z.record(z.string(), CarryOverStatSchema),
    { remote: true, gated: false },
  ),
  icon: invoke(
    "projects:icon",
    ProjectScopedPayloadSchema,
    ProjectIconSchema.nullable(),
    { remote: true, gated: false },
  ),
});
