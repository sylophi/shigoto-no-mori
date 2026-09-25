import { z } from "zod";

// Building blocks for IPC payload schemas. A call whose payload is
// exactly one of these shapes uses it directly in its contract; calls
// with extra fields .extend() it so the scoping fields stay uniform
// across the whole surface.

export const ProjectScopedPayloadSchema = z.object({
  projectId: z.string().min(1),
});

export const WorktreeScopedPayloadSchema = ProjectScopedPayloadSchema.extend({
  worktreeId: z.string().min(1),
});

export const PathPayloadSchema = z.object({
  path: z.string().min(1),
});
