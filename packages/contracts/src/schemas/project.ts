import * as Schema from "effect/Schema";
import { isCloneSource } from "../predicates/remoteUrl.ts";
import { PathPayloadSchema, ProjectScopedPayloadSchema } from "./payloads.ts";
import { strict } from "./strict.ts";

// What `deriveBranch` returns with no branch and no readable detached
// HEAD; not a real branch.
const UNKNOWN_BRANCH = "(unknown)";

export const isRealBranch = (branch: string): boolean =>
  branch !== UNKNOWN_BRANCH;

// Refs go into git argv; git rejects a leading "-" anyway, so refusing
// it here keeps input out of a flag position.
export const GitRefNameSchema = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value: string) =>
      !value.startsWith("-") || "Branch names cannot start with '-'",
  ),
);

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  // Set by ProjectsList only, as are the fields below. false: the path is
  // missing on disk.
  pathExists: Schema.optional(Schema.Boolean),
  // null never matches across devices.
  identity: Schema.optional(Schema.NullOr(Schema.String)),
  // `host/owner/repo`; null without a network remote.
  remote: Schema.optional(Schema.NullOr(Schema.String)),
  lastUsed: Schema.optional(Schema.Natural),
  recentCount: Schema.optional(Schema.Natural),
  // Merged from the terrier registry at read time, never persisted.
  source: Schema.optional(Schema.Literal("terrier")),
});
export type Project = typeof ProjectSchema.Type;

// `sm projects list --json`'s row. hue is always null, kept for the
// JSON's shape.
export const ProjectRowSchema = Schema.Struct({
  ...ProjectSchema.fields,
  pathExists: Schema.Boolean,
  identity: Schema.NullOr(Schema.String),
  remote: Schema.NullOr(Schema.String),
  lastUsed: Schema.Natural,
  recentCount: Schema.Natural,
  icon: Schema.NullOr(
    Schema.Struct({ path: Schema.String, mime: Schema.String }),
  ),
  hue: Schema.NullOr(Schema.Finite),
});
export type ProjectRow = typeof ProjectRowSchema.Type;

export const ProjectSortModeSchema = Schema.Literals([
  "alphabetical",
  "recent",
  "frequent",
  "manual",
]);
export type ProjectSortMode = typeof ProjectSortModeSchema.Type;

export const WorktreeSortModeSchema = Schema.Literals([
  "name",
  "recent",
  "created",
]);
export type WorktreeSortMode = typeof WorktreeSortModeSchema.Type;

export const SidebarViewSchema = Schema.Literals(["projects", "inbox"]);
export type SidebarView = typeof SidebarViewSchema.Type;

// One path segment.
export const CloneFolderNameSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (name: string) =>
      (!/[\\/]/.test(name) && name !== "." && name !== "..") ||
      "The folder name must be a single path segment",
  ),
);

// `terrier` also registers the repo in terrier.
export const AddProjectPayloadSchema = Schema.Struct({
  ...PathPayloadSchema.fields,
  terrier: Schema.optional(Schema.Boolean),
});

export type AddProjectPayload = typeof AddProjectPayloadSchema.Type;

// isCloneSource decides what counts: a plain path or file:// names this
// machine's disk, meaningless on the device doing the clone.
export const CloneProjectPayloadSchema = Schema.Struct({
  url: Schema.Trim.check(
    Schema.makeFilter(
      (url: string) =>
        isCloneSource(url) || "Not a git remote URL or a GitHub owner/repo",
    ),
  ),
  parentDir: Schema.NonEmptyString,
  name: Schema.optional(CloneFolderNameSchema),
  terrier: Schema.optional(Schema.Boolean),
});

export type CloneProjectPayload = typeof CloneProjectPayloadSchema.Type;

// Another device's project, set up on the device asked. No parentDir:
// that device's own layout, the two homes swapped.
export const CloneFromDevicePayloadSchema = Schema.Struct({
  deviceId: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  parentDir: Schema.optional(Schema.NonEmptyString),
});

// Ignored files brought from another device's checkout. conflicts:
// paths both sides held differently, which keep this side's version.
export const FilesBroughtSchema = strict(
  Schema.Struct({
    crossed: Schema.Boolean,
    conflicts: Schema.Natural,
    error: Schema.optional(Schema.String),
  }),
);

export const ClonedFromDeviceSchema = Schema.Struct({
  project: ProjectSchema,
  // The other device's settings, copied over the ones a new project
  // starts with. The clone stands either way.
  settings: Schema.Struct({
    copied: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }),
  // The files its carry-over copies into new worktrees, brought from
  // the other device's checkout. Absent when it names none.
  files: Schema.optional(FilesBroughtSchema),
});

export const CreateProjectPayloadSchema = Schema.Struct({
  parentDir: Schema.NonEmptyString,
  name: CloneFolderNameSchema,
  terrier: Schema.optional(Schema.Boolean),
});

export type CreateProjectPayload = typeof CreateProjectPayloadSchema.Type;

export const RemoveProjectPayloadSchema = Schema.Struct({
  id: Schema.NonEmptyString,
});

export const RelocateProjectPayloadSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
});

export const ReorderProjectsPayloadSchema = Schema.Struct({
  draggedId: Schema.NonEmptyString,
  targetId: Schema.NonEmptyString,
  position: Schema.Literals(["before", "after"]),
});

export const ProjectIconSchema = Schema.Struct({
  mime: Schema.String,
  base64: Schema.String,
});
export type ProjectIcon = typeof ProjectIconSchema.Type;

export const BranchListSchema = Schema.Struct({
  local: Schema.Array(Schema.String),
  remote: Schema.Array(Schema.String),
});
export type BranchList = typeof BranchListSchema.Type;

export const CreateBranchPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  name: GitRefNameSchema,
  base: Schema.optional(GitRefNameSchema),
});

export const RenameAnyBranchPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  oldName: GitRefNameSchema,
  newName: GitRefNameSchema,
});

export const DeleteBranchPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  name: GitRefNameSchema,
  force: Schema.optional(Schema.Boolean),
});
