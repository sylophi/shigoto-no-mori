import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Each saved terminal names its worktree in columns of its own
// (SavedTerminals.ts). A row whose owner is not a worktree's (a device
// terminal's) is not carried, nor is the table of the folder a device
// terminal last used.
export const worktreeTerminals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE worktree_terminals (
    terminal_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    history TEXT NOT NULL
  ) STRICT`;
  yield* sql`INSERT INTO worktree_terminals
    SELECT terminal_id, json_extract(owner, '$.projectId'),
      json_extract(owner, '$.worktreeId'), cwd, opened_at, seq, history
    FROM saved_terminals
    WHERE json_extract(owner, '$.kind') = 'worktree'`;
  yield* sql`DROP TABLE saved_terminals`;
  yield* sql`ALTER TABLE worktree_terminals RENAME TO saved_terminals`;
  yield* sql`DROP TABLE terminal_folder`;
});
