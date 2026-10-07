import { z } from "zod";

// The zod copy of ./payloads that schemas still on zod extend. Each
// family moves to ./payloads as it converts to Effect Schema, and this
// file goes with the last one.

export const ProjectScopedPayloadSchema = z.object({
  projectId: z.string().min(1),
});

export const WorktreeScopedPayloadSchema = ProjectScopedPayloadSchema.extend({
  worktreeId: z.string().min(1),
});
