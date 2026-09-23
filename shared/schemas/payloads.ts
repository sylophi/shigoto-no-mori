import { Schema } from "effect";

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
