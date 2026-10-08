import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
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

// The data dir's database, in WAL mode, migrated to this build's schema
// before anything reads it. Every engine service reaches the store
// through the SqlClient this provides.
export const layer: Layer.Layer<
  SqlClient.SqlClient,
  StoreOpenError | StoreImportError,
  Paths.Paths | FileSystem.FileSystem | Path.Path
> = Layer.effectContext(
  Effect.gen(function* () {
    const { store } = yield* Paths.Paths;
    const platform = yield* Effect.context<
      Paths.Paths | FileSystem.FileSystem | Path.Path
    >();
    const sql = yield* Effect.gen(function* () {
      const client = yield* SqliteClient.make({ filename: store });
      // The schema's history, applied in order. A released migration is
      // never edited; a change is a new one.
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "1_tables": tables,
          "2_import_json": Effect.provideContext(importJson, platform),
        }),
      }).pipe(Effect.provideService(SqlClient.SqlClient, client));
      return client;
    }).pipe(
      Effect.mapError((cause) => new StoreOpenError({ path: store, cause })),
      // The migrator turns a migration's failure into a defect; an import
      // that refused a file comes back out as its own error.
      Effect.catchDefect((defect) =>
        defect instanceof Migrator.MigrationError &&
        defect.cause instanceof StoreImportError
          ? Effect.fail(defect.cause)
          : Effect.die(defect),
      ),
    );
    return Context.make(SqlClient.SqlClient, sql);
  }),
).pipe(Layer.provide(Reactivity.layer));
