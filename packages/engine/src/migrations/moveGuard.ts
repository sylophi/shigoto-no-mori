import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What lets a data-folder move own the store (V3.md, Commit points):
// each mutation under way, in any process, by its process's pid and
// start (a mutation's first write, which a move refuses while it owns
// the store), and the process that made the store refuse, so one that
// died before its journal was written is told from a move under way.
export const moveGuard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mutations (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  ) STRICT`;
  yield* sql`CREATE TABLE retired_by (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  ) STRICT`;
});
