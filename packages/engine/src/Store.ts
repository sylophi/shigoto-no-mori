import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  importFiles,
  SKIPPED,
  StoreImportError,
} from "./migrations/importJson.ts";
import { agentSessions } from "./migrations/agentSessions.ts";
import { changes } from "./migrations/changes.ts";
import { dropMirrorInvites } from "./migrations/dropMirrorInvites.ts";
import { mirrorAgreements } from "./migrations/mirrorAgreements.ts";
import { mirrorHistory } from "./migrations/mirrorHistory.ts";
import { moving } from "./migrations/moving.ts";
import { runningScriptGroups } from "./migrations/runningScriptGroups.ts";
import { runningScripts } from "./migrations/runningScripts.ts";
import { tables } from "./migrations/tables.ts";
import { terminals } from "./migrations/terminals.ts";
import { unshelvedAt } from "./migrations/unshelvedAt.ts";
import { v2Import } from "./migrations/v2Import.ts";
import { wtFolder } from "./migrations/wtFolder.ts";
import { worktreeTerminals } from "./migrations/worktreeTerminals.ts";
import { wtMovesWatched } from "./migrations/wtMovesWatched.ts";
import * as Migration from "./Migration.ts";
import * as Paths from "./Paths.ts";
import { StoreError, storeErrorOf, UNMIGRATED } from "./storeErrors.ts";
import {
  hashesOf,
  recordVerified,
  removeV2Files,
  sameHashes,
  v2Files,
} from "./v2Files.ts";

export class StoreOpenError extends Schema.TaggedError<StoreOpenError>()(
  "StoreOpenError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    const store = storeErrorOf(this.cause) ?? deniedFolder(this.cause);
    return store === undefined || store.category === "failed"
      ? `Could not open the store at ${this.path}.`
      : `Could not open the store at ${this.path}. ${store.message}`;
  }
}

// The open makes the store's file before SQLite opens it, in a data
// folder that may not let it.
const deniedFolder = (cause: unknown): StoreError | undefined =>
  Predicate.isTagged(cause, "PlatformError") &&
  Predicate.hasProperty(cause, "reason") &&
  Predicate.isTagged(cause.reason, "PermissionDenied")
    ? new StoreError({ category: "read-only", cause })
    : undefined;

// Opens a database file, in WAL mode unless `disableWAL`, with the
// driver of the process's runtime: `@effect/sql-sqlite-node` in the host,
// `@effect/sql-sqlite-bun` in the terminal binary (Bun's SQLite can't
// load extensions, which the node driver asks for).
export type OpenDatabase = (
  filename: string,
  options?: {
    readonly disableWAL?: boolean;
    readonly busyTimeout?: Duration.Input;
  },
) => Effect.Effect<
  SqlClient.SqlClient,
  SqlError,
  Scope.Scope | Reactivity.Reactivity
>;

const migrate = Migrator.make({});

type Platform = Context.Context<
  Paths.Paths | FileSystem.FileSystem | Path.Path
>;

// The services the migrations that read files run on, and nothing else
// of where the store is opened: a process may open it under another
// store's SqlClient (a proof's engine), which a migration must not
// write to.
const platformOnly = Effect.map(
  Effect.context<Paths.Paths | FileSystem.FileSystem | Path.Path>(),
  Context.pick(Paths.Paths, FileSystem.FileSystem, Path.Path),
);

// The schema's history, in order, its imports of a 2.x data dir's files
// `lenient` or not (importJson.ts). A store records only which steps it
// ran, so a released migration never changes the tables it makes: a
// change is a new one.
const history = (platform: Platform, lenient: boolean) => ({
  "1_tables": tables,
  "2_import_json": Effect.provideContext(importFiles(lenient), platform),
  "3_agent_sessions": Effect.provideContext(agentSessions, platform),
  "4_changes": changes,
  "5_unshelved_at": Effect.provideContext(unshelvedAt, platform),
  "6_terminals": terminals,
  "7_wt_folder": wtFolder,
  "8_running_scripts": runningScripts,
  "9_mirror_agreements": Effect.provideContext(mirrorAgreements, platform),
  "10_mirror_history": Effect.provideContext(mirrorHistory, platform),
  "12_v2_import": v2Import,
  "13_moving": moving,
  "14_wt_moves_watched": wtMovesWatched,
  "15_worktree_terminals": worktreeTerminals,
  "16_drop_mirror_invites": dropMirrorInvites,
  "17_running_script_groups": runningScriptGroups,
});

// Whether the store holds what a 2.x data dir's files said: the files
// imported again, into memory, skip nothing, and give every table the
// rows the store has. What the import couldn't read, or anything else
// it can't tell, is a doubt.
const importVerified = (open: OpenDatabase, platform: Platform) =>
  Effect.gen(function* () {
    const store = yield* SqlClient.SqlClient;
    let skips = 0;
    const counting = Logger.make((options) => {
      if (JSON.stringify(options.message).includes(SKIPPED)) skips += 1;
    });
    const memory = yield* open(":memory:");
    yield* migrate({
      loader: Migrator.fromRecord(history(platform, false)),
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, memory),
      Effect.provide(Logger.layer([counting], { mergeWithExisting: true })),
    );
    if (skips > 0) return false;
    const held = yield* store<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name <> 'effect_sql_migrations' ORDER BY name`;
    for (const { name } of held) {
      const rows = (client: SqlClient.SqlClient) =>
        Effect.map(client.unsafe(`SELECT * FROM "${name}"`), (found) =>
          found.map((row) => JSON.stringify(row)).toSorted(),
        );
      const [kept, said] = [yield* rows(store), yield* rows(memory)];
      if (
        kept.length !== said.length ||
        kept.some((row, i) => row !== said[i])
      ) {
        return false;
      }
    }
    return true;
  }).pipe(Effect.scoped);

// After an import, the 2.x files it read deleted, once the store is
// verified to hold what they said; on any doubt every one stays, and the
// doctor reports them.
const removeImported = (open: OpenDatabase, platform: Platform) =>
  Effect.gen(function* () {
    const files = yield* v2Files;
    // The files as they are on either side of the verification: one a
    // v2 build wrote meanwhile isn't the one verified.
    const before = yield* hashesOf(files);
    const verified = yield* importVerified(open, platform);
    const after = yield* hashesOf(yield* v2Files);
    // Every file hashed on both sides: one that couldn't be read is a
    // doubt too.
    const read = Object.keys(before).length === files.length;
    if (!verified || !read || !sameHashes(before, after)) {
      return yield* Effect.logWarning(
        "Left the v2 files in place: the import couldn't be verified",
      );
    }
    yield* recordVerified(before);
    yield* removeV2Files(files);
  }).pipe(
    Effect.provideContext(platform),
    Effect.catchCause((cause) =>
      Effect.logWarning("Left the v2 files in place", cause),
    ),
  );

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
      const path = yield* Path.Path;
      const migration = yield* Migration.Migration;
      const platform = yield* platformOnly;
      const importing = (state: "running" | "done") =>
        migration.update((current) =>
          current.import === null ? current : { ...current, import: { state } },
        );
      // A store that failed to open or import, stuck with why. One that
      // failed before it could tell an import was owed (a driver that
      // won't load) owes one all the same when the 2.x files are there.
      const stuck = (reason: string) =>
        Effect.gen(function* () {
          const v2 = yield* Effect.forEach(V2_FILES, (file) =>
            fs
              .exists(path.join(dataDir, file))
              .pipe(Effect.orElseSucceed(() => false)),
          );
          yield* migration.update((current) =>
            current.import === null && !v2.some(Boolean)
              ? current
              : {
                  planned: true,
                  import: { state: "stuck", reason },
                  worktrees: current.worktrees ?? Migration.WAITING_MOVE,
                },
          );
        });
      const sql = yield* Effect.gen(function* () {
        // A fresh device has no data dir until its first command.
        yield* fs.makeDirectory(dataDir, { recursive: true });
        // The store holds what the machine's other accounts must not
        // read, a terminal's saved history among it, so it is the
        // owner's alone. SQLite gives the journal files it makes the
        // database's mode.
        yield* fs.writeFile(store, new Uint8Array(), {
          flag: "a",
          mode: 0o600,
        });
        // While a data-folder move's journal is here the store refuses
        // writes, until the engine graph settles it (dataDirMove.ts).
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
        const latest = yield* latestApplied.pipe(
          Effect.provideService(SqlClient.SqlClient, client),
        );
        // A schema this build doesn't know, which it would read wrong and
        // could write wrong: the updater never offers a lower version, and
        // the store refuses one too.
        if (latest > newest) {
          return yield* new StoreError({ category: "newer", cause: latest });
        }
        const due = owed || latest < newest;
        const ran = due
          ? yield* migrate({ loader: Migrator.fromRecord(migrations) }).pipe(
              Effect.provideService(SqlClient.SqlClient, client),
            )
          : [];
        // This process's import, not one another process made as this
        // one waited for the lock.
        if (ran.some(([id]) => id === 2)) {
          yield* removeImported(open, platform).pipe(
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
        Effect.tapError((error) => stuck(error.message)),
      );
      return Context.make(SqlClient.SqlClient, sql);
    }),
  ).pipe(Layer.provide(Reactivity.layer));

// The data dir's 2.x files in a database in memory, `lenient` or not
// (importJson.ts): leniently, what the store would refuse is skipped.
// Every write is refused (UNMIGRATED), since it would go nowhere. The
// doctor reads them this way while the store can't import them or the
// app has yet to, and the terminal while the app has yet to migrate
// them (`unmigrated`).
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
      const platform = yield* platformOnly;
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
