import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// v2 kept worktrees under `worktrees/`; v3 keeps them under `wt/`, so
// the paths agents and people read all day are short. The move is made
// once, at the engine's start, outside this migration's transaction
// (WtFolder.ts): `wt_move_scan`'s row says the v2 roots are still to be
// looked through, and each worktree found there is a row of `wt_moves`.
// `moved` stays set once it is done, so the host can re-open a mirror
// whose root moved; `error` holds why a move couldn't be made, which
// the doctor reports and retries.
export const wtFolder = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE wt_moves (
    from_path TEXT PRIMARY KEY,
    to_path TEXT NOT NULL,
    project_id TEXT NOT NULL,
    moved INTEGER NOT NULL DEFAULT 0,
    error TEXT
  ) STRICT`;
  yield* sql`CREATE TABLE wt_move_scan (
    id INTEGER PRIMARY KEY CHECK (id = 1)
  ) STRICT`;
  yield* sql`INSERT INTO wt_move_scan (id) VALUES (1)`;
});
