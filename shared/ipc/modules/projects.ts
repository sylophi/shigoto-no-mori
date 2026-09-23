import { Schema } from "effect";
import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  BranchListSchema,
  CloneProjectPayloadSchema,
  PathPayloadSchema,
  ProjectIconSchema,
  ProjectSchema,
  ProjectScopedPayloadSchema,
  ProjectSortModeSchema,
  RemoveProjectPayloadSchema,
  ReorderProjectsPayloadSchema,
  SetProjectSortPayloadSchema,
  ToggleCollapsedProjectPayloadSchema,
  CarryOverCandidateSchema,
  CarryOverListingPayloadSchema,
  CarryOverStatSchema,
  CarryOverStatsPayloadSchema,
  WorktreeIncludeStatusSchema,
} from "@shared/schemas";

export const projectsContract = defineContract("host", {
  list: invoke("projects:list", Schema.Undefined, Schema.Array(ProjectSchema), {
    remote: true,
    mutating: false,
  }),
  add: invoke("projects:add", PathPayloadSchema, ProjectSchema, {
    remote: true,
    mutating: true,
  }),
  // Runs for as long as the clone does. The wire has no per-call
  // timeout, and the device doing the clone uses its own credentials.
  clone: invoke("projects:clone", CloneProjectPayloadSchema, ProjectSchema, {
    remote: true,
    mutating: true,
  }),
  remove: invoke(
    "projects:remove",
    RemoveProjectPayloadSchema,
    Schema.Undefined,
    {
      remote: true,
      mutating: true,
    },
  ),
  reorder: invoke(
    "projects:reorder",
    ReorderProjectsPayloadSchema,
    Schema.Undefined,
    {
      remote: true,
      mutating: true,
    },
  ),
  getSort: invoke("projects:getSort", Schema.Undefined, ProjectSortModeSchema, {
    remote: true,
    mutating: false,
  }),
  setSort: invoke(
    "projects:setSort",
    SetProjectSortPayloadSchema,
    Schema.Undefined,
    {
      remote: true,
      mutating: true,
    },
  ),
  getCollapsed: invoke(
    "projects:getCollapsed",
    Schema.Undefined,
    Schema.Array(Schema.String),
    {
      remote: true,
      mutating: false,
    },
  ),
  // Returns the post-toggle list so the renderer can sync to disk truth.
  toggleCollapsed: invoke(
    "projects:toggleCollapsed",
    ToggleCollapsedProjectPayloadSchema,
    Schema.Array(Schema.String),
    { remote: true, mutating: true },
  ),
  // Emitted after an action bumps a project's usage so the renderer can
  // refresh its usage-sorted sidebar list.
  usageBumped: broadcast("projects:usageBumped", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  defaultBranch: invoke(
    "projects:defaultBranch",
    ProjectScopedPayloadSchema,
    Schema.String,
    { remote: true, mutating: false },
  ),
  // The remote another device would clone to get this repo, or null
  // when it has none. Credentials never ride along (shared/cloneUrl.ts).
  cloneUrl: invoke(
    "projects:cloneUrl",
    ProjectScopedPayloadSchema,
    Schema.NullOr(Schema.String),
    { remote: true, mutating: false },
  ),
  listBranches: invoke(
    "projects:listBranches",
    ProjectScopedPayloadSchema,
    BranchListSchema,
    { remote: true, mutating: false },
  ),
  pickWorktreeName: invoke(
    "projects:pickWorktreeName",
    ProjectScopedPayloadSchema,
    Schema.String,
    { remote: true, mutating: false },
  ),
  worktreeIncludeStatus: invoke(
    "projects:worktreeIncludeStatus",
    ProjectScopedPayloadSchema,
    WorktreeIncludeStatusSchema,
    { remote: true, mutating: false },
  ),
  // Named for its first caller. The leave-out preset's picker reads it
  // too, on every device holding the repo, so the name stays for the
  // peers that know it.
  // The two carry-over outputs embed config.ts's zod schemas, so they
  // stay zod until it ports (Phase 4 wave 2).
  carryOverListing: invoke(
    "projects:carryOverListing",
    CarryOverListingPayloadSchema,
    z.array(CarryOverCandidateSchema),
    { remote: true, mutating: false },
  ),
  carryOverStats: invoke(
    "projects:carryOverStats",
    CarryOverStatsPayloadSchema,
    z.record(z.string(), CarryOverStatSchema),
    { remote: true, mutating: false },
  ),
  icon: invoke(
    "projects:icon",
    ProjectScopedPayloadSchema,
    Schema.NullOr(ProjectIconSchema),
    { remote: true, mutating: false },
  ),
});
