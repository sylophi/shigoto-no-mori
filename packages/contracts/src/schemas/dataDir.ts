import * as Schema from "effect/Schema";
import { ProjectSchema } from "./project.ts";
import { PackageScriptSortModeSchema } from "./scripts.ts";

// The JSON documents a 2.x data dir keeps at its top level, which the
// engine's store imports once (packages/engine/src/migrations). Each
// key is decoded on its own, since a key one build can't read must not
// cost the others.

// registry.json: the projects, the manual order and the worktree marks.
export const RegistryFileSchema = Schema.Struct({
  // In registration order.
  projects: Schema.Array(
    Schema.Struct({
      id: ProjectSchema.fields.id,
      name: ProjectSchema.fields.name,
      path: ProjectSchema.fields.path,
    }),
  ),
  // The sidebar's manual order, as project paths.
  projectOrder: Schema.Array(Schema.String),
  // Worktree ids marked on: only `true` counts.
  shelvedWorktrees: Schema.Record(Schema.String, Schema.Boolean),
  autoPullWorktrees: Schema.Record(Schema.String, Schema.Boolean),
  // Each entry decoded on its own: one that doesn't parse reads as absent.
  shelfSnapshots: Schema.Record(Schema.String, Schema.Unknown),
  deviceId: Schema.String,
  // Each entry kept as it is, readable or not.
  sharedSettings: Schema.Struct({
    entries: Schema.Record(Schema.String, Schema.Unknown),
  }),
});

// What a shelved worktree looked like when it went on the shelf.
export const ShelfSnapshotSchema = Schema.Struct({
  at: Schema.Int,
  head: Schema.NullOr(Schema.String),
  changed: Schema.Int,
});

// Millisecond timestamps of each use, newest pruned to a window only
// when the same name is used again.
const UseLogSchema = Schema.Array(Schema.Int);

// state.json: use logs and the package scripts' arrangement, by project
// id. Before registry.json existed it held the projects and the shelf
// too.
export const StateFileSchema = Schema.Struct({
  projectUseLog: Schema.Record(Schema.String, UseLogSchema),
  launcherUseLog: Schema.Record(Schema.String, UseLogSchema),
  packageScriptUseLog: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, UseLogSchema),
  ),
  packageScriptSort: Schema.Record(Schema.String, PackageScriptSortModeSchema),
  packageScriptOrder: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  packageScriptLaunchRow: Schema.Record(
    Schema.String,
    Schema.Array(Schema.String),
  ),
  projects: RegistryFileSchema.fields.projects,
  shelvedWorktrees: RegistryFileSchema.fields.shelvedWorktrees,
});
