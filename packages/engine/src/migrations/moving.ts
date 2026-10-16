import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The worktree moves under way (worktrees/moving.ts): each written before
// git moves the checkout and deleted in the transaction that carries
// what is kept under its id, so a row the next start finds is a move a
// crash or an interrupt cut short. `partial` is the sibling a copy to
// another volume fills, and the pid with its start tells a move still
// running in another process from one whose process is gone. Not
// watched (changes.ts): no view reads it.
export const moving = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE moving (
    from_path TEXT PRIMARY KEY,
    to_path TEXT NOT NULL,
    project_id TEXT NOT NULL,
    partial TEXT,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  ) STRICT`;
});
