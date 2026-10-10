import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The tables a view is read from. The two caches (icon_cache,
// clone_verified) are left out: nothing shows them, and a clone checkout
// writes a row per file. So are the saved terminals, which only the
// host's next start reads, and the one-time move into wt/'s (wt_moves,
// wt_move_scan), which only the doctor reads.
const firstTables = [
  "projects",
  "project_order",
  "worktree_marks",
  "shelf_snapshots",
  "device",
  "shared_settings",
  "device_config",
  "project_config",
  "worktree_data",
  "usage",
  "script_sort",
  "script_lists",
  "agent_sessions",
] as const;

export const watchedTables = [...firstTables, "unshelved_at"] as const;

// A version per watched table, which a trigger moves on every row any
// connection writes, so a reader learns which tables changed by reading
// one small table (StoreChanges.ts). A table added later adds itself
// here in its own migration.
export const changes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE changes (
    name TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0
  ) STRICT, WITHOUT ROWID`;
  for (const table of firstTables) yield* watchTable(table);
});

// The version row and triggers of one table.
export const watchTable = (table: (typeof watchedTables)[number]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO changes (name) VALUES (${table})`;
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      // Names can't be bound, and these are this module's own.
      yield* sql.unsafe(
        `CREATE TRIGGER changes_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN UPDATE changes SET version = version + 1 WHERE name = '${table}'; END`,
      );
    }
  });
