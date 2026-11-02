import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The scan into wt/ owed again (WtFolder.ts). One made before this step
// recorded a v2 root two projects of one folder name share under one of
// them, which dropped the other's worktrees as strays, and was done even
// when it couldn't see a project's roots. What it recorded stays.
export const wtMoveRescan = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO wt_move_scan (id) VALUES (1) ON CONFLICT DO NOTHING`;
});
