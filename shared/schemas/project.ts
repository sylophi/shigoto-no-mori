import { z } from "zod";

// Sentinel returned by `deriveBranch` when a worktree has no branch and
// no detached HEAD we can read. Treated as "not a real branch" by every
// consumer that filters branches for operations (delete, switch, etc.).
export const UNKNOWN_BRANCH = "(unknown)";

export const isRealBranch = (branch: string): boolean =>
  branch !== UNKNOWN_BRANCH;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  // Populated by ProjectsList only — `false` means the project's path is
  // missing on disk (deleted/moved/unmounted). Other handlers don't set it.
  pathExists: z.boolean().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const AddProjectPayloadSchema = z.object({
  path: z.string(),
});

export const RemoveProjectPayloadSchema = z.object({
  id: z.string(),
});

export const ReorderProjectsPayloadSchema = z.object({
  draggedId: z.string(),
  targetId: z.string(),
  position: z.enum(["before", "after"]),
});

export const ProjectsDefaultBranchPayloadSchema = z.object({
  projectId: z.string(),
});

export const ProjectsListBranchesPayloadSchema = z.object({
  projectId: z.string(),
});

export const PickWorktreeNamePayloadSchema = z.object({
  projectId: z.string(),
});

export const ListIgnoredPathsPayloadSchema = z.object({
  projectId: z.string(),
});

export const ProjectIconPayloadSchema = z.object({
  projectId: z.string(),
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
export const CreateBranchPayloadSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  base: z.string().min(1).optional(),
});

export const RenameAnyBranchPayloadSchema = z.object({
  projectId: z.string(),
  oldName: z.string().min(1),
  newName: z.string().min(1),
});

export const DeleteBranchPayloadSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
});
