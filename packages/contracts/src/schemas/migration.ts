import * as Schema from "effect/Schema";

// Where one step of the v3 migration is: not started, under way,
// finished, or finished with something it couldn't do (the step says
// what).
const MigrationStepStateSchema = Schema.Literals([
  "waiting",
  "running",
  "done",
  "stuck",
]);

// A worktree the move into `wt/` left in its v2 folder, and why in
// git's words (a locked worktree, a folder in use).
const StuckWorktreeSchema = Schema.Struct({
  name: Schema.String,
  reason: Schema.String,
});

// The move of v2's worktrees into `wt/`: how many of the migration's
// moves are made, and the one under way.
const WorktreeMoveStepSchema = Schema.Struct({
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
// nothing reads planned with both null. This device's sign-in for its
// key is the window's own (useEnrollment), not the host's.
export const MigrationSchema = Schema.Struct({
  planned: Schema.Boolean,
  import: Schema.NullOr(Schema.Struct({ state: MigrationStepStateSchema })),
  worktrees: Schema.NullOr(WorktreeMoveStepSchema),
});
export type MigrationProgress = typeof MigrationSchema.Type;

// Whether a migration has a page to show: this start owes steps. The
// page shows it until it opens the app, every step done, or a person
// continues past one.
export const migrationShows = (migration: MigrationProgress): boolean =>
  migration.planned &&
  (migration.import !== null || migration.worktrees !== null);
