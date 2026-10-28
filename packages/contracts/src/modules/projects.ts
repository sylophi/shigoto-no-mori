import * as Schema from "effect/Schema";
import { push, defineContract, invoke, view } from "../contract.ts";
import {
  AddProjectPayloadSchema,
  BranchListSchema,
  CloneFromDevicePayloadSchema,
  ClonedFromDeviceSchema,
  CloneProjectPayloadSchema,
  CreateProjectPayloadSchema,
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
  view("watch", VoidSchema, Schema.Array(ProjectSchema), {
    remote: true,
    gated: false,
  }),
  invoke("add", AddProjectPayloadSchema, ProjectSchema, {
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
  // Another device's project, cloned here from its checkout (that
  // device's grant) with its settings and the files its carry-over
  // names. Runs for as long as the clone does.
  invoke(
    "cloneFromDevice",
    CloneFromDevicePayloadSchema,
    ClonedFromDeviceSchema,
    {
      remote: true,
      gated: true,
      grant: "browseFiles",
    },
  ),
  // A new repository with an empty first commit, so its default
  // branch exists for worktrees to branch off.
  invoke("create", CreateProjectPayloadSchema, ProjectSchema, {
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
  push("usageBumped", ProjectScopedPayloadSchema, {
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
  // An image the project's markdown names on one of its remotes' hosts,
  // read by the device holding the project, as a data: URL. A window
  // loads only GitHub's image hosts itself (its policy names no other).
  invoke(
    "remoteImage",
    Schema.Struct({ ...ProjectScopedPayloadSchema.fields, url: Schema.String }),
    Schema.String,
    { remote: true, gated: false },
  ),
);
