import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The host's terminals as the last quit left them: each one's owner as
// JSON (a worktree's `{"kind":"worktree","projectId","worktreeId"}`, or
// `{"kind":"device"}`), the folder its shell was in, its last output
// chunk's seq and the history ring's text. And the folder a device's
// next terminal starts in. worktreeTerminals.ts gives a worktree its
// own columns.
export const terminals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE saved_terminals (
    terminal_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    cwd TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    history TEXT NOT NULL
  ) STRICT`;
  yield* sql`CREATE TABLE terminal_folder (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    path TEXT NOT NULL
  ) STRICT`;
});
