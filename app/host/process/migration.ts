// The shell hears when the v3 migration starts and ends, so its windows
// show the migration's page while it runs (main/electron/windows.ts).
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import * as Migration from "@shigomori/engine/Migration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { onShell, shellCalls } from "./shell";

const running = (migration: MigrationProgress) =>
  (migration.import !== null || migration.worktrees !== null) &&
  !Migration.finished(migration);

export const tellShell = Layer.effectDiscard(
  Effect.flatMap(Migration.Migration, (migration) =>
    migration.changes.pipe(
      Stream.map(running),
      Stream.changes,
      Stream.runForEach((on) =>
        onShell(() => shellCalls().migrating(on)).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    ),
  ),
);
