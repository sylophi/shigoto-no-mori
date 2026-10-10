import * as Schema from "effect/Schema";

// Where one step of the v3 migration is: not started, under way,
// finished, or finished with something it couldn't do (the step says
// what).
export const MigrationStepStateSchema = Schema.Literals([
  "waiting",
  "running",
  "done",
  "stuck",
]);
export type MigrationStepState = typeof MigrationStepStateSchema.Type;

// A worktree the move into `wt/` left in its v2 folder, and why in
// git's words (a locked worktree, a folder in use).
export const StuckWorktreeSchema = Schema.Struct({
  name: Schema.String,
  reason: Schema.String,
});
export type StuckWorktree = typeof StuckWorktreeSchema.Type;

// The move of v2's worktrees into `wt/`: how many of the migration's
// moves are made, and the one under way.
export const WorktreeMoveStepSchema = Schema.Struct({
  state: MigrationStepStateSchema,
  moved: Schema.Number,
  total: Schema.Number,
  current: Schema.NullOr(Schema.String),
  stuck: Schema.Array(StuckWorktreeSchema),
});
export type WorktreeMoveStep = typeof WorktreeMoveStepSchema.Type;

// What this start of the engine owes a 2.x data dir, as it goes: the
// import of its JSON files into the store, and the move of its
// worktrees into `wt/`. A step it doesn't owe is null. Until `planned`,
// it is still finding out (the store opening), and a start that owes
// nothing reads planned with both null.
export const StoreMigrationSchema = Schema.Struct({
  planned: Schema.Boolean,
  import: Schema.NullOr(Schema.Struct({ state: MigrationStepStateSchema })),
  worktrees: Schema.NullOr(WorktreeMoveStepSchema),
});
export type StoreMigration = typeof StoreMigrationSchema.Type;

// The whole migration a window shows: the engine's steps, and this
// device's sign-in to the account it was enrolled on (its new key and
// its registration with the hub), which goes by itself while the
// session lives and waits on the person once it has lapsed.
export const MigrationSchema = Schema.Struct({
  ...StoreMigrationSchema.fields,
  signIn: Schema.NullOr(
    Schema.Struct({
      state: MigrationStepStateSchema,
      lapsed: Schema.Boolean,
    }),
  ),
});
export type Migration = typeof MigrationSchema.Type;
