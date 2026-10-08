import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { importJson, StoreImportError } from "./migrations/importJson.ts";
import { tables } from "./migrations/tables.ts";
import * as Paths from "./Paths.ts";

export class StoreOpenError extends Schema.TaggedError<StoreOpenError>()(
  "StoreOpenError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not open the store at ${this.path}.`;
  }
}

// Opens the database file in WAL mode, with the driver of the process's
// runtime: `@effect/sql-sqlite-node` in the host, `@effect/sql-sqlite-bun`
// in the terminal binary (Bun's SQLite can't load extensions, which the
// node driver asks for).
export type OpenDatabase = (
  filename: string,
) => Effect.Effect<
  SqlClient.SqlClient,
  SqlError,
  Scope.Scope | Reactivity.Reactivity
>;

const migrate = Migrator.make({});

// The data dir's database, migrated to this build's schema before
// anything reads it. Every engine service reaches the store through the
// SqlClient this provides.
export const layer = (
  open: OpenDatabase,
): Layer.Layer<
  SqlClient.SqlClient,
  StoreOpenError | StoreImportError,
  Paths.Paths | FileSystem.FileSystem | Path.Path
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { dataDir, store } = yield* Paths.Paths;
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* Effect.context<
        Paths.Paths | FileSystem.FileSystem | Path.Path
      >();
      const sql = yield* Effect.gen(function* () {
        // A fresh device has no data dir until its first command.
        yield* fs.makeDirectory(dataDir, { recursive: true });
        const client = yield* open(store);
        // The schema's history, applied in order. A released migration is
        // never edited. A change is a new one.
        yield* migrate({
          loader: Migrator.fromRecord({
            "1_tables": tables,
            "2_import_json": Effect.provideContext(importJson, platform),
          }),
        }).pipe(Effect.provideService(SqlClient.SqlClient, client));
        return client;
      }).pipe(
        Effect.mapError((cause) => new StoreOpenError({ path: store, cause })),
        // The migrator turns a migration's failure into a defect. An import
        // that refused a file comes back out as its own error, and any other
        // failed migration as a store that can't open.
        Effect.catchDefect(
          (defect): Effect.Effect<never, StoreOpenError | StoreImportError> =>
            !(defect instanceof Migrator.MigrationError)
              ? Effect.die(defect)
              : defect.cause instanceof StoreImportError
                ? Effect.fail(defect.cause)
                : Effect.fail(
                    new StoreOpenError({ path: store, cause: defect }),
                  ),
        ),
      );
      return Context.make(SqlClient.SqlClient, sql);
    }),
  ).pipe(Layer.provide(Reactivity.layer));
