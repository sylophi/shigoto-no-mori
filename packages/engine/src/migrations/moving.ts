import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The worktree moves under way (worktrees/moving.ts): each written before
// git moves the checkout and deleted once the move is carried whole, so
// a row the next start finds is a move a crash or an interrupt cut
// short. `link` is the checkout's `.git` file, which git's move keeps,
// telling the moved checkout from another made at the destination since.
// `carried` is set in the transaction that re-keys what is kept under
// its id, which a resume never repeats. `partial` is the sibling a copy
// to another volume fills. The pid with its start tells a move still
// running in another process from one whose process is gone. Not
// watched (changes.ts): no view reads it.
export const moving = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE moving (
    from_path TEXT PRIMARY KEY,
    to_path TEXT NOT NULL,
    project_id TEXT NOT NULL,
    link TEXT NOT NULL,
    carried INTEGER NOT NULL DEFAULT 0,
    partial TEXT,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  ) STRICT`;
});
