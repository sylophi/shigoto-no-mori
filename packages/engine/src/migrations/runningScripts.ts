import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Paths from "../Paths.ts";

// What a 2.x running-scripts.json holds: the app instance that wrote it,
// and the scripts it started and had not seen exit.
const V2_PID = Schema.Int.check(Schema.isGreaterThanOrEqualTo(2));
const V2SnapshotText = Schema.fromJsonString(
  Schema.Struct({
    ownerPid: V2_PID,
    scripts: Schema.Array(Schema.Unknown),
  }),
);
const decodeScript = Schema.decodeUnknownOption(
  Schema.Struct({
    runId: Schema.NonEmptyString,
    pid: V2_PID,
    projectId: Schema.NonEmptyString,
    worktreeId: Schema.NonEmptyString,
    startedAt: Schema.Int.check(Schema.isGreaterThan(0)),
    command: Schema.String,
  }),
);

// The scripts the app started and has not seen exit (RunningScripts.ts),
// each with the app instance that started it, so the next start can
// stop what a crash left running. A pid is the leader of the script's
// process group, which the sweep signals as -pid: pid 1 would be every
// process the app may signal, and an owner of 1 (launchd) would always
// read as alive, so neither is a row. A 2.x data dir's
// running-scripts.json is taken once, under the v2 app that wrote it,
// so the first start's sweep stops what a v2 crash left running and
// drops the rows. A file or an entry that doesn't parse is skipped,
// which sweeps nothing.
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { dataDir } = yield* Paths.Paths;
  const file = path.join(dataDir, "running-scripts.json");
  const snapshot = yield* fs
    .readFileString(file)
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(V2SnapshotText)),
      Effect.option,
    );
  if (Option.isNone(snapshot)) return;
  const { ownerPid, scripts } = snapshot.value;
  for (const entry of scripts) {
    const script = decodeScript(entry);
    if (Option.isNone(script)) continue;
    const s = script.value;
    yield* sql`INSERT INTO running_scripts ${sql.insert({
      run_id: s.runId,
      owner_pid: ownerPid,
      pid: s.pid,
      project_id: s.projectId,
      worktree_id: s.worktreeId,
      started_at: s.startedAt,
      command: s.command,
    })} ON CONFLICT DO NOTHING`;
  }
});
