import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  importFiles,
  importJson,
  StoreImportError,
} from "./migrations/importJson.ts";
import { agentSessions } from "./migrations/agentSessions.ts";
import { changes } from "./migrations/changes.ts";
import { tables } from "./migrations/tables.ts";
import { terminals } from "./migrations/terminals.ts";
import { unshelvedAt } from "./migrations/unshelvedAt.ts";
import { wtFolder } from "./migrations/wtFolder.ts";
import * as Migration from "./Migration.ts";
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

// Whether the store has yet to import a 2.x data dir's files: the
// registry is there, and the import hasn't run (the migrations commit
// together, so one cut short by a crash runs again).
const owesImport = (registryFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* fs.exists(registryFile))) return false;
    const [table] = yield* sql`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'effect_sql_migrations'`;
    if (table === undefined) return true;
    const [imported] = yield* sql`SELECT migration_id
      FROM effect_sql_migrations WHERE migration_id = 2`;
    return imported === undefined;
  });

// The data dir's database, migrated to this build's schema before
// anything reads it. Every engine service reaches the store through the
// SqlClient this provides. An import of a 2.x data dir is reported to
// the migration as it runs, and with it the move into `wt/` it brings.
export const layer = (
  open: OpenDatabase,
): Layer.Layer<
  SqlClient.SqlClient,
  StoreOpenError | StoreImportError,
  Paths.Paths | FileSystem.FileSystem | Path.Path | Migration.Migration
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { dataDir, store } = yield* Paths.Paths;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migration = yield* Migration.Migration;
      const platform = yield* Effect.context<
        Paths.Paths | FileSystem.FileSystem | Path.Path
      >();
      const importing = (state: "running" | "done" | "stuck") =>
        migration.update((current) =>
          current.import === null ? current : { ...current, import: { state } },
        );
      const sql = yield* Effect.gen(function* () {
        // A fresh device has no data dir until its first command.
        yield* fs.makeDirectory(dataDir, { recursive: true });
        const client = yield* open(store);
        const owed = yield* owesImport(
          path.join(dataDir, "registry.json"),
        ).pipe(Effect.provideService(SqlClient.SqlClient, client));
        if (owed) {
          yield* migration.update(() => ({
            planned: true,
            import: { state: "running" },
            worktrees: Migration.WAITING_MOVE,
          }));
        }
        // The schema's history, applied in order. A released migration is
        // never edited. A change is a new one.
        yield* migrate({
          loader: Migrator.fromRecord({
            "1_tables": tables,
            "2_import_json": Effect.provideContext(importJson, platform),
            "3_agent_sessions": agentSessions,
            "4_changes": changes,
            "5_unshelved_at": Effect.provideContext(unshelvedAt, platform),
            "6_terminals": terminals,
            "7_wt_folder": wtFolder,
          }),
        }).pipe(Effect.provideService(SqlClient.SqlClient, client));
        yield* importing("done");
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
        Effect.tapError(() => importing("stuck")),
      );
      return Context.make(SqlClient.SqlClient, sql);
    }),
  ).pipe(Layer.provide(Reactivity.layer));

// The data dir's 2.x files in a database in memory, imported leniently:
// what the store would refuse is skipped, as the Go sm read around it.
// The doctor reads them this way while the store can't import them.
export const fromFiles = (
  open: OpenDatabase,
): Layer.Layer<
  SqlClient.SqlClient,
  StoreOpenError,
  Paths.Paths | FileSystem.FileSystem | Path.Path
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const platform = yield* Effect.context<
        Paths.Paths | FileSystem.FileSystem | Path.Path
      >();
      const client = yield* open(":memory:");
      yield* migrate({
        loader: Migrator.fromRecord({
          "1_tables": tables,
          "2_import_json": Effect.provideContext(importFiles(true), platform),
          "3_agent_sessions": agentSessions,
          "4_changes": changes,
          "5_unshelved_at": Effect.provideContext(unshelvedAt, platform),
          "7_wt_folder": wtFolder,
        }),
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.mapError(
          (cause) => new StoreOpenError({ path: ":memory:", cause }),
        ),
      );
      return Context.make(SqlClient.SqlClient, client);
    }).pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new StoreOpenError({ path: ":memory:", cause })),
      }),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
