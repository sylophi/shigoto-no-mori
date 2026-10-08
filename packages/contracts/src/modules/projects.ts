import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import {
  BranchListSchema,
  CloneProjectPayloadSchema,
  PathPayloadSchema,
  ProjectIconSchema,
  ProjectSchema,
  ProjectScopedPayloadSchema,
  RelocateProjectPayloadSchema,
  RemoveProjectPayloadSchema,
  ReorderProjectsPayloadSchema,
  CarryOverCandidateSchema,
  CarryOverListingPayloadSchema,
  CarryOverStatSchema,
  CarryOverStatsPayloadSchema,
  VoidSchema,
  WorktreeIncludeStatusSchema,
} from "../schemas/index.ts";

export const projectsContract = defineContract(
  "projects",
  "host",
  invoke("list", VoidSchema, Schema.Array(ProjectSchema), {
    remote: true,
    gated: false,
  }),
  invoke("add", PathPayloadSchema, ProjectSchema, {
    remote: true,
    gated: true,
    grant: "browseFiles",
  }),
  // Runs for as long as the clone does. The wire has no per-call
  // timeout, and the device doing the clone uses its own credentials.
  invoke("clone", CloneProjectPayloadSchema, ProjectSchema, {
    remote: true,
    gated: true,
    grant: "browseFiles",
  }),
  invoke("remove", RemoveProjectPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  // For a project whose repo was moved or renamed by hand. Answers the
  // project at its new path.
  invoke("relocate", RelocateProjectPayloadSchema, ProjectSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  invoke("reorder", ReorderProjectsPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  // Emitted after an action bumps a project's usage so the renderer can
  // refresh its usage-sorted sidebar list.
  broadcast("usageBumped", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  invoke("defaultBranch", ProjectScopedPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  // The remote another device would clone to get this repo, or null
  // when it has none. Credentials never ride along (shared/cloneUrl.ts).
  invoke("cloneUrl", ProjectScopedPayloadSchema, Schema.NullOr(Schema.String), {
    remote: true,
    gated: false,
  }),
  invoke("listBranches", ProjectScopedPayloadSchema, BranchListSchema, {
    remote: true,
    gated: false,
  }),
  invoke("pickWorktreeName", ProjectScopedPayloadSchema, Schema.String, {
    remote: true,
    gated: false,
  }),
  invoke(
    "worktreeIncludeStatus",
    ProjectScopedPayloadSchema,
    WorktreeIncludeStatusSchema,
    { remote: true, gated: false },
  ),
  // Named for its first caller. The leave-out preset's picker reads it
  // too, on every device holding the repo, so the name stays for the
  // peers that know it.
  invoke(
    "carryOverListing",
    CarryOverListingPayloadSchema,
    Schema.Array(CarryOverCandidateSchema),
    { remote: true, gated: false },
  ),
  invoke(
    "carryOverStats",
    CarryOverStatsPayloadSchema,
    Schema.Record(Schema.String, CarryOverStatSchema),
    { remote: true, gated: false },
  ),
  invoke("icon", ProjectScopedPayloadSchema, Schema.NullOr(ProjectIconSchema), {
    remote: true,
    gated: false,
  }),
);
