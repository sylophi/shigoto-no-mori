import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether a running script leads its own process group, which the sweep
// signals as one: a script's PTY run does, and a lifecycle script, run
// in the host's group, does not (RunningScripts.ts). Every row before
// this step was a PTY run's.
export const runningScriptGroups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE running_scripts
    ADD COLUMN group_leader INTEGER NOT NULL DEFAULT 1
    CHECK (group_leader IN (0, 1))`;
});
