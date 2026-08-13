import { z } from "zod";
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
export const GitRefNameSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("-"), {
    message: "Branch names cannot start with '-'",
  });

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  // Populated by ProjectsList only — `false` means the project's path is
  // missing on disk (deleted/moved/unmounted). Other handlers don't set it.
  pathExists: z.boolean().optional(),
  // Usage stats, populated by ProjectsList only, feeding the sidebar
  // "most recently used" / "most used" sorts. `lastUsed` is the newest
  // action timestamp (0 if never); `recentCount` is the rolling-window
  // action count. Other handlers don't set them.
  lastUsed: z.number().int().nonnegative().optional(),
  recentCount: z.number().int().nonnegative().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

// Sidebar project ordering. `manual` is the user-arranged drag order and the
// implicit default; `frequent` = most used, `recent` = most recently used —
// matching the package.json scripts sort vocabulary.
export const ProjectSortModeSchema = z.enum([
  "alphabetical",
  "recent",
  "frequent",
  "manual",
]);
export type ProjectSortMode = z.infer<typeof ProjectSortModeSchema>;

export const SetProjectSortPayloadSchema = z.object({
  mode: ProjectSortModeSchema,
});

// Sidebar collapse state: toggles one project id in the persisted
// collapsed set. A toggle (rather than a whole-list write) keeps the
// read-modify-write in the main process, so a stale renderer cache
// can't clobber collapse state it didn't know about.
export const ToggleCollapsedProjectPayloadSchema = z.object({
  projectId: z.string().min(1),
});

export const RemoveProjectPayloadSchema = z.object({
  id: z.string().min(1),
});

export const ReorderProjectsPayloadSchema = z.object({
  draggedId: z.string().min(1),
  targetId: z.string().min(1),
  position: z.enum(["before", "after"]),
});

// Bytes for a detected project icon, ready to drop into a data URL.
// `null` from the handler means no candidate file was found.
export const ProjectIconSchema = z.object({
  mime: z.string(),
  base64: z.string(),
});
export type ProjectIcon = z.infer<typeof ProjectIconSchema>;

export const BranchListSchema = z.object({
  local: z.array(z.string()),
  remote: z.array(z.string()),
});
export type BranchList = z.infer<typeof BranchListSchema>;

// Branch operations against the project's primary repo (not tied to any
// specific worktree). Used by the Manage Branches page.
export const CreateBranchPayloadSchema = ProjectScopedPayloadSchema.extend({
  name: GitRefNameSchema,
  base: GitRefNameSchema.optional(),
});

export const RenameAnyBranchPayloadSchema = ProjectScopedPayloadSchema.extend({
  oldName: GitRefNameSchema,
  newName: GitRefNameSchema,
});

export const DeleteBranchPayloadSchema = ProjectScopedPayloadSchema.extend({
  name: GitRefNameSchema,
  force: z.boolean().optional(),
});
