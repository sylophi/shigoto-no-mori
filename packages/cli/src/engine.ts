// The engine under the terminal: the store over Bun's SQLite, and the
// darwin helper beside the binary.
import { dirname, join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as DataDirLock from "@shigomori/engine/DataDirLock";
import type { Flavor } from "@shigomori/engine/flavor";
import { doctorLayer, engineServices } from "@shigomori/engine/layer";
import * as Migration from "@shigomori/engine/Migration";
import * as Paths from "@shigomori/engine/Paths";
import * as Store from "@shigomori/engine/Store";
import { StoreError } from "@shigomori/engine/storeErrors";
import * as Command from "effect/cli/Command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const open: Store.OpenDatabase = (filename, options) =>
  SqliteClient.make({ filename, ...options });
const macfs = join(dirname(process.execPath), "macfs");
// What the agent hooks run: this binary (Agents names it by its real
// path).
const sm = process.execPath;

// Whether the data dir is a 2.x one the app has yet to migrate.
export class Unmigrated extends Context.Service<
  Unmigrated,
  { readonly owed: boolean }
>()("sm/cli/Unmigrated") {}

// The engine. A 2.x data dir is the app's to migrate, or `doctor
// --fix`'s: an agent's hook or a script must not move worktrees out
// from under the work running in them. Until then the commands read
// what v2 left, in memory, and a write there is refused
// (`Store.fromFiles`).
export const engine = (flavor: Flavor) =>
  Layer.unwrap(
    Effect.map(Store.importOwed(open), (owed) =>
      engineServices({
        flavor,
        store: owed ? Store.fromFiles(open, true) : Store.layer(open),
        open,
        macfs,
        sm,
      }).pipe(
        Layer.provideMerge(Migration.layer),
        Layer.merge(Layer.succeed(Unmigrated, { owed })),
      ),
    ),
  ).pipe(Layer.provideMerge(Paths.layer(flavor)));

// Before a command that changes a worktree on disk, which a data dir
// still v2's would not record.
export const refuseUnmigrated = Effect.gen(function* () {
  if ((yield* Unmigrated).owed) {
    return yield* new StoreError({ category: "unmigrated", cause: undefined });
  }
});

// A command that changes git, its refs or files, run while no
// data-folder move can start: the lock held for the command's run
// (`DataDirLock`). One that writes only the store needs none, since a
// move's store refuses it.
const holdingLock = Layer.effectDiscard(
  Effect.flatMap(DataDirLock.DataDirLock, (lock) => lock.held),
);
export const changing = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
) => Command.provide(command, holdingLock);

// `sm doctor`, which changes something only with `--fix`.
export const changingWithFix = <
  Name extends string,
  Input extends { readonly fix: boolean },
  ContextInput,
  E,
  R,
>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
) =>
  Command.provide(command, (input) => (input.fix ? holdingLock : Layer.empty));

// `sm doctor`'s, which opens the store inside each run, so a store that
// won't open still gets its checklist.
export const doctor = (flavor: Flavor) => doctorLayer({ flavor, open, macfs });
