import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The scripts the app started and has not seen exit (RunningScripts.ts),
// each with the app instance that started it, so the next start can
// stop what a crash left running. A pid is the leader of the script's
// process group, which the sweep signals as -pid: pid 1 would be every
// process the app may signal, and an owner of 1 (launchd) would always
// read as alive, so neither is a row.
export const runningScripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE running_scripts (
    run_id TEXT PRIMARY KEY,
    owner_pid INTEGER NOT NULL CHECK (owner_pid >= 2),
    pid INTEGER NOT NULL CHECK (pid >= 2),
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    started_at INTEGER NOT NULL CHECK (started_at > 0),
    command TEXT NOT NULL
  ) STRICT`;
});
