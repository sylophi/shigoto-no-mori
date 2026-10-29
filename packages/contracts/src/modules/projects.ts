import * as Schema from "effect/Schema";
import { push, defineContract, invoke, view } from "../contract.ts";
import { strict } from "../schemas/strict.ts";
import { SyncPullProgressSchema } from "./sync.ts";
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

// How far a clone has got, as git reports it: the step it is on (the
// remote's packing, the download, the delta resolve, the checkout) and
// that step's percent, with the bytes received so far once it downloads.
const CloneProgressSchema = strict(
  Schema.Struct({
    step: Schema.Literals(["remote", "receiving", "resolving", "checkout"]),
    percent: Schema.Natural,
    bytes: Schema.optional(Schema.Natural),
  }),
);
export type CloneProgress = typeof CloneProgressSchema.Type;

// A clone's progress, for the call that asked for it, keyed by the
// parentDir and name it was asked with.
const CloneProgressPushSchema = strict(
  Schema.Struct({
    parentDir: Schema.String,
    name: Schema.String,
    progress: CloneProgressSchema,
  }),
);
export type CloneProgressPush = typeof CloneProgressPushSchema.Type;

// How far a clone of another device's project has got, for the call
// that asked for it, keyed by the deviceId and projectId it was asked
// with: the repo's bytes as they cross, then the carry-over files'.
const CloneFromDeviceProgressSchema = strict(
  Schema.Struct({
    deviceId: Schema.String,
    projectId: Schema.String,
    step: SyncPullProgressSchema.struct.fields.step,
    bytes: SyncPullProgressSchema.struct.fields.bytes,
    totalBytes: SyncPullProgressSchema.struct.fields.totalBytes,
  }),
);
export type CloneFromDeviceProgress = typeof CloneFromDeviceProgressSchema.Type;

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
  push("cloneProgress", CloneProgressPushSchema, { remote: true }),
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
  push("cloneFromDeviceProgress", CloneFromDeviceProgressSchema, {
    remote: true,
  }),
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
  // A remove that deletes the project's worktrees and repo folder too.
  invoke("delete", RemoveProjectPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
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
