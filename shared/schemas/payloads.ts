import { Schema } from "effect";
import { z } from "zod";

// Building blocks for IPC payload schemas. A call whose payload is
// exactly one of these shapes uses it directly in its contract; calls
// with extra fields spread its `fields` into a new Schema.Struct so the
// scoping fields stay uniform across the whole surface.

export const ProjectScopedPayloadSchema = Schema.Struct({
  projectId: Schema.NonEmptyString,
});

export const WorktreeScopedPayloadSchema = Schema.Struct({
  ...ProjectScopedPayloadSchema.fields,
  worktreeId: Schema.NonEmptyString,
});

export const PathPayloadSchema = Schema.Struct({
  path: Schema.NonEmptyString,
});

// The zod form of ProjectScopedPayloadSchema, for config.ts's payloads
// that still extend it: a zod object cannot hold a Schema field.
// Phase 4 wave 2 removes this.
export const ProjectScopedPayloadZod = z.object({
  projectId: z.string().min(1),
});
