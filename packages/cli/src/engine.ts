// The engine under the terminal: the store over Bun's SQLite, and the
// darwin helper beside the binary.
import { dirname, join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import type { Flavor } from "@shigomori/engine/flavor";
import { doctorLayer, engineLayer } from "@shigomori/engine/layer";
import * as Migration from "@shigomori/engine/Migration";
import * as Paths from "@shigomori/engine/Paths";
import * as Store from "@shigomori/engine/Store";
import { StoreError } from "@shigomori/engine/storeErrors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const open: Store.OpenDatabase = (filename) => SqliteClient.make({ filename });
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
      engineLayer({
        flavor,
        store: owed ? Store.fromFiles(open, true) : Store.layer(open),
        macfs,
        sm,
      }).pipe(
        Layer.provideMerge(Migration.layer),
        Layer.merge(Layer.succeed(Unmigrated, { owed })),
      ),
    ),
  ).pipe(Layer.provide(Paths.layer(flavor)));

// Before a command that changes a worktree on disk, which a data dir
// still v2's would not record.
export const refuseUnmigrated = Effect.gen(function* () {
  if ((yield* Unmigrated).owed) {
    return yield* new StoreError({ category: "unmigrated", cause: undefined });
  }
});

// `sm doctor`'s, which opens the store inside each run, so a store that
// won't open still gets its checklist.
export const doctor = (flavor: Flavor) => doctorLayer({ flavor, open, macfs });
