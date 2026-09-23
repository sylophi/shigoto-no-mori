import { Schema } from "effect";
import { z } from "zod";
import { isCloneableRemote } from "@shared/cloneUrl";
import { ProjectScopedPayloadSchema } from "./payloads";

// Sentinel returned by `deriveBranch` when a worktree has no branch and
// no detached HEAD we can read. Treated as "not a real branch" by every
// consumer that filters branches for operations (delete, switch, etc.).
export const UNKNOWN_BRANCH = "(unknown)";

export const isRealBranch = (branch: string): boolean =>
  branch !== UNKNOWN_BRANCH;

// Branch names and base refs cross the IPC boundary straight into git
// argv. git itself rejects refs starting with "-" (check-ref-format),
// so refusing them here costs nothing and guarantees user input can
// never land in a flag position (`--track`, `-D`, ...).
const GIT_REF_LEADING_DASH = "Branch names cannot start with '-'";
const hasNoLeadingDash = (value: string): boolean => !value.startsWith("-");

export const GitRefNameSchema = Schema.NonEmptyString.check(
  Schema.makeFilter(hasNoLeadingDash, { message: GIT_REF_LEADING_DASH }),
);

// The zod form of GitRefNameSchema, for the sync and mirror wire
// contracts that still embed it: a zod object cannot hold a Schema
// field. Phase 4 wave 3 removes this.
export const GitRefNameZod = z
  .string()
  .min(1)
  .refine(hasNoLeadingDash, { message: GIT_REF_LEADING_DASH });

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  // Populated by ProjectsList only. `false` means the project's path is
  // missing on disk (deleted/moved/unmounted). Other handlers don't set it.
  pathExists: Schema.optional(Schema.Boolean),
  // Repo identity (shared/git/repoIdentity.mts), populated by ProjectsList
  // only. `null` means the repo has none (or the probe failed), so it
  // never matches across devices. Other handlers don't set it.
  identity: Schema.optional(Schema.NullOr(Schema.String)),
  // Usage stats, populated by ProjectsList only, feeding the sidebar
  // "most recently used" / "most used" sorts. `lastUsed` is the newest
  // action timestamp (0 if never); `recentCount` is the rolling-window
  // action count. Other handlers don't set them.
  lastUsed: Schema.optional(NonNegativeInt),
  recentCount: Schema.optional(NonNegativeInt),
  // "terrier" marks a project merged from the terrier registry rather
  // than registry.json. Never persisted: the merge layer decorates it
  // at read time (host/lib/projects, cli/terrier.go), and the id is
  // minted deterministically from the path so both engines agree
  // without coordination. Terrier-sourced projects can't be removed.
  source: Schema.optional(Schema.Literal("terrier")),
});
export type Project = typeof ProjectSchema.Type;

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

export const SetProjectSortPayloadSchema = Schema.Struct({
  mode: ProjectSortModeSchema,
});

// Which sidebar layout the user picked. "projects" is the classic tree
// grouped by project. "inbox" is the flat, cross-project list split into
// active / shelved / merged boxes, newest work first. "projects" is the
// implicit default, so an install that never touches the toggle reads
// back the layout it has always had.
const SIDEBAR_VIEWS = ["projects", "inbox"] as const;
export const SidebarViewSchema = Schema.Literals(SIDEBAR_VIEWS);
export type SidebarView = typeof SidebarViewSchema.Type;
export const isSidebarView = Schema.is(SidebarViewSchema);

// Sidebar collapse state: toggles one project id in the persisted
// collapsed set. A toggle (rather than a whole-list write) keeps the
// read-modify-write in the main process, so a stale renderer cache
// can't clobber collapse state it didn't know about.
export const ToggleCollapsedProjectPayloadSchema = Schema.Struct({
  projectId: Schema.NonEmptyString,
});

// Clone a remote into `parentDir` and register the checkout. What
// counts as a remote is isCloneableRemote's call (a plain path or
// file:// names this machine's disk, which means nothing on the device
// doing the clone, and a leading dash would read as a git option).
// `name` is the new folder, one segment, defaulting to the repo's own
// name. Both strings are trimmed before their checks run.
export const CloneProjectPayloadSchema = Schema.Struct({
  url: Schema.Trim.check(
    Schema.makeFilter(isCloneableRemote, { message: "Not a git remote URL" }),
  ),
  parentDir: Schema.NonEmptyString,
  name: Schema.optional(
    Schema.Trim.check(
      Schema.isNonEmpty(),
      Schema.makeFilter(
        (name: string) => !/[\\/]/.test(name) && name !== "." && name !== "..",
        { message: "The folder name must be a single path segment" },
      ),
    ),
  ),
});

export type CloneProjectPayload = typeof CloneProjectPayloadSchema.Type;

export const RemoveProjectPayloadSchema = Schema.Struct({
  id: Schema.NonEmptyString,
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
