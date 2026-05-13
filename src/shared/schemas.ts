// Zod schemas for IPC validation. Types in shared/types.ts derive from these.
import { z } from "zod";

export const WorktreeStatusSchema = z.enum([
  "clean",
  "dirty",
  "ahead",
  "behind",
  "diverged",
]);

export const CommitSummarySchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
});

export const WorktreeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branch: z.string(),
  path: z.string(),
  status: WorktreeStatusSchema,
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirtyCount: z.number().int().nonnegative(),
  lastCommit: CommitSummarySchema.nullable(),
  isPrimary: z.boolean().optional(),
  port: z.number().int().positive().optional(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
});

export const ProjectsListResultSchema = z.array(ProjectSchema);
export const WorktreesListResultSchema = z.array(WorktreeSchema);

export const AddProjectPayloadSchema = z.object({
  path: z.string(),
});

export const RemoveProjectPayloadSchema = z.object({
  id: z.string(),
});

export const ListWorktreesPayloadSchema = z.object({
  projectId: z.string(),
});

export const CreateWorktreePayloadSchema = z.object({
  projectId: z.string(),
  branchName: z.string().min(1),
  base: z.string().optional(),
});

export const DeleteWorktreePayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  force: z.boolean().default(false),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;
export type CommitSummary = z.infer<typeof CommitSummarySchema>;
