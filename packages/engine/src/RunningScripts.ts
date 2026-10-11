import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// A script the app started and has not seen exit, and the app instance
// that started it (its pid). Two instances on one data dir (a dev build
// pointed at the packaged one's) each keep their own, so one's sweep
// never takes the other's live scripts for a crash's leftovers.
export type RunningScript = {
  readonly runId: string;
  readonly ownerPid: number;
  // The leader of the script's process group.
  readonly pid: number;
  readonly projectId: string;
  readonly worktreeId: string;
  // Epoch ms, stamped just after the spawn.
  readonly startedAt: number;
  readonly command: string;
};

export class RunningScripts extends Context.Service<
  RunningScripts,
  {
    readonly list: Effect.Effect<ReadonlyArray<RunningScript>>;
    readonly add: (script: RunningScript) => Effect.Effect<void>;
    readonly remove: (runIds: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("sm/engine/RunningScripts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list = sql<{
    run_id: string;
    owner_pid: number;
    pid: number;
    project_id: string;
    worktree_id: string;
    started_at: number;
    command: string;
  }>`SELECT * FROM running_scripts ORDER BY started_at, run_id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        runId: row.run_id,
        ownerPid: row.owner_pid,
        pid: row.pid,
        projectId: row.project_id,
        worktreeId: row.worktree_id,
        startedAt: row.started_at,
        command: row.command,
      })),
    ),
    Effect.orDie,
    Effect.withSpan("RunningScripts.list"),
  );

  const add = Effect.fn("RunningScripts.add")(function* (
    script: RunningScript,
  ) {
    const row = {
      run_id: script.runId,
      owner_pid: script.ownerPid,
      pid: script.pid,
      project_id: script.projectId,
      worktree_id: script.worktreeId,
      started_at: script.startedAt,
      command: script.command,
    };
    yield* sql`INSERT OR REPLACE INTO running_scripts ${sql.insert(row)}`;
  }, Effect.orDie);

  const remove = Effect.fn("RunningScripts.remove")(function* (
    runIds: ReadonlyArray<string>,
  ) {
    if (runIds.length === 0) return;
    yield* sql`DELETE FROM running_scripts WHERE ${sql.in("run_id", runIds)}`;
  }, Effect.orDie);

  return RunningScripts.of({ list, add, remove });
});

export const layer = Layer.effect(RunningScripts, make);
