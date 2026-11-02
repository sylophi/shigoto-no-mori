import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The scan into wt/ owed once more (WtFolder.ts). One made before this
// step recorded a v2 root two projects of one folder name share under
// the first, which dropped the other's worktrees as strays or left them
// under it. This one records them under their own, and what else the
// first recorded stays.
export const wtMoveRescan = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO wt_move_scan (id) VALUES (1) ON CONFLICT DO NOTHING`;
});
