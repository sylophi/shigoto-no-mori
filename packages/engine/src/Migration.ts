// The v3 migration as it goes: what this start of the engine owes a
// 2.x data dir and how far it is, for the app's migration screen and
// the terminal's lines. The store reports its import as it opens
// (Store.ts), and the move into `wt/` each worktree as it goes
// (WtFolder.ts). It is built before them, so a process can show it
// while the store is still opening.
import type {
  MigrationProgress,
  WorktreeMoveStep,
} from "@shigomori/contracts/schemas/migration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class Migration extends Context.Service<
  Migration,
  {
    readonly current: Effect.Effect<MigrationProgress>;
    // The current value, then each change.
    readonly changes: Stream.Stream<MigrationProgress>;
    readonly update: (
      f: (migration: MigrationProgress) => MigrationProgress,
    ) => Effect.Effect<void>;
  }
>()("sm/engine/Migration") {}

export const WAITING_MOVE: WorktreeMoveStep = {
  state: "waiting",
  moved: 0,
  total: 0,
  current: null,
  stuck: [],
};

// Whether every step this start owes has ended, done or stuck.
export const finished = (migration: MigrationProgress) =>
  migration.planned &&
  [migration.import, migration.worktrees].every(
    (step) => step === null || step.state === "done" || step.state === "stuck",
  );

const make = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<MigrationProgress>({
    planned: false,
    import: null,
    worktrees: null,
  });
  return Migration.of({
    current: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
    update: (f) => SubscriptionRef.update(ref, f),
  });
});

export const layer = Layer.effect(Migration, make);
