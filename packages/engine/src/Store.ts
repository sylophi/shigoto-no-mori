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
import { importFiles, StoreImportError } from "./migrations/importJson.ts";
import { agentSessions } from "./migrations/agentSessions.ts";
import { changes } from "./migrations/changes.ts";
import { mirrorAgreements } from "./migrations/mirrorAgreements.ts";
import { mirrorHistory } from "./migrations/mirrorHistory.ts";
import { mirrorInvites } from "./migrations/mirrorInvites.ts";
import { runningScripts } from "./migrations/runningScripts.ts";
import { tables } from "./migrations/tables.ts";
import { terminals } from "./migrations/terminals.ts";
import { unshelvedAt } from "./migrations/unshelvedAt.ts";
import { wtFolder } from "./migrations/wtFolder.ts";
import * as Migration from "./Migration.ts";
import * as Paths from "./Paths.ts";
import { storeErrorOf, UNMIGRATED } from "./storeErrors.ts";

export class StoreOpenError extends Schema.TaggedError<StoreOpenError>()(
  "StoreOpenError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    const store = storeErrorOf(this.cause);
    return store === undefined || store.category === "failed"
      ? `Could not open the store at ${this.path}.`
      : `Could not open the store at ${this.path}. ${store.message}`;
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

type Platform = Context.Context<
  Paths.Paths | FileSystem.FileSystem | Path.Path
>;

// The schema's history, in order, its imports of a 2.x data dir's files
// `lenient` or not (importJson.ts). A released migration is never
// edited. A change is a new one.
const history = (platform: Platform, lenient: boolean) => ({
  "1_tables": tables,
  "2_import_json": Effect.provideContext(importFiles(lenient), platform),
  "3_agent_sessions": agentSessions,
  "4_changes": changes,
  "5_unshelved_at": Effect.provideContext(unshelvedAt, platform),
  "6_terminals": terminals,
  "7_wt_folder": wtFolder,
  "8_running_scripts": runningScripts,
  "9_mirror_agreements": Effect.provideContext(mirrorAgreements, platform),
  "10_mirror_history": Effect.provideContext(mirrorHistory, platform),
  "11_mirror_invites": Effect.provideContext(mirrorInvites, platform),
});

// The newest migration a store applied, 0 for a new one.
const latestApplied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [table] = yield* sql`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (table === undefined) return 0;
  const [row] = yield* sql<{ latest: number | null }>`
    SELECT MAX(migration_id) AS latest FROM effect_sql_migrations`;
  return row?.latest ?? 0;
});

// The files a 2.x data dir keeps its state in, which the import takes.
const V2_FILES = ["registry.json", "config.json", "state.json"];

// Whether the store has yet to import a 2.x data dir's files: one of
// them is there, and the import hasn't run (the migrations commit
// together, so one cut short by a crash runs again).
const owesImport = (dataDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const files = yield* Effect.forEach(V2_FILES, (file) =>
      fs.exists(path.join(dataDir, file)),
    );
    if (!files.some(Boolean)) return false;
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
        // The store holds what the machine's other accounts must not
        // read, a terminal's saved history among it, so it is the
        // owner's alone. SQLite gives the journal files it makes the
        // database's mode, and those an older build made are put right
        // (a drive with no modes, or a file not there, has none to fix).
        yield* fs.writeFile(store, new Uint8Array(), {
          flag: "a",
          mode: 0o600,
        });
        for (const file of [store, `${store}-wal`, `${store}-shm`]) {
          yield* fs.chmod(file, 0o600).pipe(Effect.ignore);
        }
        const client = yield* open(store);
        const owed = yield* owesImport(dataDir).pipe(
          Effect.provideService(SqlClient.SqlClient, client),
        );
        if (owed) {
          yield* migration.update(() => ({
            planned: true,
            import: { state: "running" },
            worktrees: Migration.WAITING_MOVE,
          }));
        }
        // The schema's history, applied in order. Run only when one is
        // due, since the migrator takes the write lock: a start that only
        // reads must not wait on the app's writes, or fail behind them.
        const migrations = history(platform, false);
        const newest = Math.max(
          ...Object.keys(migrations).map((key) => Number.parseInt(key, 10)),
        );
        const due =
          owed ||
          (yield* latestApplied.pipe(
            Effect.provideService(SqlClient.SqlClient, client),
          )) < newest;
        if (due) {
          yield* migrate({ loader: Migrator.fromRecord(migrations) }).pipe(
            Effect.provideService(SqlClient.SqlClient, client),
          );
        }
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

// The data dir's 2.x files in a database in memory, `lenient` or not
// (importJson.ts): leniently, what the store would refuse is skipped, as
// the Go sm read around it. Every write is refused (UNMIGRATED), since
// it would go nowhere. The doctor reads them this way while the store
// can't import them or the app has yet to, and the terminal while the
// app has yet to migrate them (`unmigrated`).
export const fromFiles = (
  open: OpenDatabase,
  lenient: boolean,
): Layer.Layer<
  SqlClient.SqlClient,
  StoreOpenError | StoreImportError,
  Paths.Paths | FileSystem.FileSystem | Path.Path
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const platform = yield* Effect.context<
        Paths.Paths | FileSystem.FileSystem | Path.Path
      >();
      const client = yield* open(":memory:");
      yield* migrate({
        loader: Migrator.fromRecord(history(platform, lenient)),
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.mapError(
          (cause) => new StoreOpenError({ path: ":memory:", cause }),
        ),
        Effect.catchDefect((defect) =>
          defect instanceof Migrator.MigrationError &&
          defect.cause instanceof StoreImportError
            ? Effect.fail(defect.cause)
            : Effect.die(defect),
        ),
      );
      const made = yield* client<{ name: string }>`SELECT name
        FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
      for (const { name } of made) {
        for (const change of ["INSERT", "UPDATE", "DELETE"]) {
          yield* client.unsafe(
            `CREATE TRIGGER "${name}_${change.toLowerCase()}_unmigrated"
              BEFORE ${change} ON "${name}"
              BEGIN SELECT RAISE(ABORT, '${UNMIGRATED}'); END`,
          );
        }
      }
      return Context.make(SqlClient.SqlClient, client);
    }).pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new StoreOpenError({ path: ":memory:", cause })),
      }),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

// Whether the data dir is a 2.x one still to be migrated: its files are
// there, and the store has yet to import them. Read without making or
// migrating the store.
export const importOwed = (
  open: OpenDatabase,
): Effect.Effect<
  boolean,
  StoreOpenError,
  Paths.Paths | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { dataDir, store } = yield* Paths.Paths;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = (file: string) =>
      fs
        .exists(file)
        .pipe(
          Effect.mapError((cause) => new StoreOpenError({ path: file, cause })),
        );
    const v2 = yield* Effect.forEach(V2_FILES, (file) =>
      exists(path.join(dataDir, file)),
    );
    if (!v2.some(Boolean)) return false;
    if (!(yield* exists(store))) return true;
    return yield* Effect.flatMap(open(store), (client) =>
      owesImport(dataDir).pipe(
        Effect.provideService(SqlClient.SqlClient, client),
      ),
    ).pipe(
      Effect.scoped,
      Effect.provide(Reactivity.layer),
      Effect.mapError((cause) => new StoreOpenError({ path: store, cause })),
    );
  });
