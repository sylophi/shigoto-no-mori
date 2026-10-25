import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A saved terminal may be its device's, which names no worktree: the
// table again with its worktree's columns nullable, every row carried.
export const deviceTerminals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE owned_terminals (
    terminal_id TEXT PRIMARY KEY,
    project_id TEXT,
    worktree_id TEXT,
    cwd TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    history TEXT NOT NULL,
    CHECK ((project_id IS NULL) = (worktree_id IS NULL))
  ) STRICT`;
  yield* sql`INSERT INTO owned_terminals
    SELECT terminal_id, project_id, worktree_id, cwd, opened_at, seq, history
    FROM saved_terminals`;
  yield* sql`DROP TABLE saved_terminals`;
  yield* sql`ALTER TABLE owned_terminals RENAME TO saved_terminals`;
});
