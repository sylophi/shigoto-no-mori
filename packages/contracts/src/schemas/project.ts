import * as Schema from "effect/Schema";
import { isCloneSource } from "../predicates/remoteUrl.ts";
import { PathPayloadSchema, ProjectScopedPayloadSchema } from "./payloads.ts";

// Sentinel returned by `deriveBranch` when a worktree has no branch and
// no detached HEAD we can read. Treated as "not a real branch" by every
// consumer that filters branches for operations (delete, switch, etc.).
const UNKNOWN_BRANCH = "(unknown)";

export const isRealBranch = (branch: string): boolean =>
  branch !== UNKNOWN_BRANCH;

// Branch names and base refs cross the IPC boundary straight into git
// argv. git itself rejects refs starting with "-" (check-ref-format),
// so refusing them here costs nothing and guarantees user input can
// never land in a flag position (`--track`, `-D`, ...).
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
  // Populated by ProjectsList only. `false` means the project's path is
  // missing on disk (deleted/moved/unmounted). Other handlers don't set it.
  pathExists: Schema.optional(Schema.Boolean),
  // Repo identity (the engine's Identity.ts), populated by ProjectsList
  // only. `null` means the repo has none (or the probe failed), so it
  // never matches across devices. Other handlers don't set it.
  identity: Schema.optional(Schema.NullOr(Schema.String)),
  // The primary remote as `host/owner/repo` (the engine's Identity.ts), populated by ProjectsList only, for grouping the
  // sidebar's projects by owner. `null` means the repo has no network
  // remote. Absent from a peer on an older build.
  remote: Schema.optional(Schema.NullOr(Schema.String)),
  // Usage stats, populated by ProjectsList only, feeding the sidebar
  // "most recently used" / "most used" sorts. `lastUsed` is the newest
  // action timestamp (0 if never); `recentCount` is the rolling-window
  // action count. Other handlers don't set them.
  lastUsed: Schema.optional(Schema.Natural),
  recentCount: Schema.optional(Schema.Natural),
  // "terrier" marks a project merged from the terrier registry rather
  // than the app's own registry. Never persisted: the engine's merge decorates
  // it at read time (Terrier.ts), and the id is minted
  // deterministically from the path. Terrier-sourced projects can't be
  // removed.
  source: Schema.optional(Schema.Literal("terrier")),
});
export type Project = typeof ProjectSchema.Type;

// One row of `sm projects list --json`: the project decorated the way
// ProjectsList serves it, plus the icon the engine resolved (a file
// path and its type) and a hue that is always null, kept for the
// JSON's shape. Host-internal: the icon bytes reach the renderer
// through projects:icon.
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

// Sidebar project ordering. `manual` is the user-arranged drag order and the
// implicit default; `frequent` = most used, `recent` = most recently
// used, matching the package.json scripts sort vocabulary.
export const ProjectSortModeSchema = Schema.Literals([
  "alphabetical",
  "recent",
  "frequent",
  "manual",
]);
export type ProjectSortMode = typeof ProjectSortModeSchema.Type;

// How the tree orders an open project's worktrees, picked per project.
// `name` is the default. `recent` puts the most recently active first
// (worktreeLastActivityAt), `created` the most recently added.
export const WorktreeSortModeSchema = Schema.Literals([
  "name",
  "recent",
  "created",
]);
export type WorktreeSortMode = typeof WorktreeSortModeSchema.Type;

// Which sidebar layout the user picked. "projects" is the classic tree
// grouped by project. "inbox" is the flat, cross-project list split into
// active / shelved / merged boxes, newest work first. "projects" is the
// implicit default, so an install that never touches the toggle reads
// back the layout it has always had.
export const SidebarViewSchema = Schema.Literals(["projects", "inbox"]);
export type SidebarView = typeof SidebarViewSchema.Type;

// The folder a clone or a new repository lands in: one path segment
// under the parent the caller picked.
export const CloneFolderNameSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (name: string) =>
      (!/[\\/]/.test(name) && name !== "." && name !== "..") ||
      "The folder name must be a single path segment",
  ),
);

// `terrier` also registers the repo in terrier (host/lib/terrier.ts),
// for a device with the integration on. The add, the clone and the
// create all take it.
export const AddProjectPayloadSchema = Schema.Struct({
  ...PathPayloadSchema.fields,
  terrier: Schema.optional(Schema.Boolean),
});

export type AddProjectPayload = typeof AddProjectPayloadSchema.Type;

// Clone a remote, or a GitHub repository by its `owner/repo`, into
// `parentDir` and register the checkout. What counts is isCloneSource's
// call (a plain path or file:// names this machine's disk, which means
// nothing on the device doing the clone, and a leading dash would read
// as an option). `name` is the new folder, one segment, defaulting to
// the repo's own name.
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

// Start a new repository at `parentDir/name` and register it.
export const CreateProjectPayloadSchema = Schema.Struct({
  parentDir: Schema.NonEmptyString,
  name: CloneFolderNameSchema,
  terrier: Schema.optional(Schema.Boolean),
});

export type CreateProjectPayload = typeof CreateProjectPayloadSchema.Type;

export const RemoveProjectPayloadSchema = Schema.Struct({
  id: Schema.NonEmptyString,
});

// Points a project at where its repo lives now (`sm projects relocate`).
export const RelocateProjectPayloadSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
});

export const ReorderProjectsPayloadSchema = Schema.Struct({
  draggedId: Schema.NonEmptyString,
  targetId: Schema.NonEmptyString,
  position: Schema.Literals(["before", "after"]),
});

// Bytes for a detected project icon, ready to drop into a data URL.
// `null` from the handler means no candidate file was found.
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

// Branch operations against the project's primary repo (not tied to any
// specific worktree). Used by the Manage Branches page.
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
