import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProcessTable from "./ProcessTable.ts";

// A script the app started and has not seen exit, and the app instance
// that started it (its pid). Two instances on one data dir (a dev build
// pointed at the packaged one's) each keep their own, so one's sweep
// never takes the other's live scripts for a crash's leftovers.
export type RunningScript = {
  readonly runId: string;
  readonly ownerPid: number;
  readonly pid: number;
  // Whether `pid` leads the script's process group: a PTY run's does,
  // while a lifecycle script runs in the app's group.
  readonly groupLeader: boolean;
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
    group_leader: number;
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
        groupLeader: row.group_leader === 1,
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
      group_leader: script.groupLeader ? 1 : 0,
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

// The recorded command is what we handed the login shell, but a shell
// execs into the last command of what it runs, so the live command
// line is often one program with its own argv: `pnpm i && pnpm dev`
// shows up as `node .../pnpm.cjs dev`, and a shell-quoted absolute
// path loses its quotes. Accept the whole recorded command, or the
// program of any command in it (past its `NAME=value` words and an
// `exec`, which aren't in the live line), or that program's basename,
// and treat anything else as inconclusive.
const commandMatches = (recorded: string, live: string) => {
  const trimmed = recorded.trim();
  if (trimmed === "") return false;
  if (live.includes(trimmed)) return true;
  return trimmed.split(/[;&|\n]+/).some((command) => {
    const program = command
      .trim()
      .replace(/^(?:(?:\w+=(?:"[^"]*"|'[^']*'|\S*)|exec)\s+)*/, "")
      .split(/\s+/)[0];
    const head = (program ?? "").replace(/['"]/g, "");
    const base = head.slice(head.lastIndexOf("/") + 1);
    return base !== "" && (live.includes(head) || live.includes(base));
  });
};

// The identity proof. A live pid says nothing on its own, so three
// independent facts have to agree: the process leads its own group when
// it did (a script's PTY child leads a session of its own, and setsid
// survives an exec, while a lifecycle script ran in the app's group),
// where the OS has groups, it started when we recorded that it started,
// and its command line still looks like the one we launched.
const isSameProcess = (
  record: RunningScript,
  live: ProcessTable.LiveProcess | undefined,
) =>
  live !== undefined &&
  (live.leadsGroup === undefined || record.groupLeader === live.leadsGroup) &&
  Math.abs(live.startedAt - record.startedAt) <=
    ProcessTable.BIRTH_TOLERANCE_MS &&
  commandMatches(record.command, live.command);

// The recorded scripts still running as the processes they recorded:
// what the doctor reports and the next boot's sweep stops. A record may
// be days old and its pid a stranger's by now, so every inconclusive
// answer leaves a record out.
export const survivors = Effect.fnUntraced(function* (
  records: ReadonlyArray<RunningScript>,
) {
  if (records.length === 0) return [];
  const table = yield* (yield* ProcessTable.ProcessTable).listed(
    records.map(({ pid }) => pid),
  );
  return records.filter((record) =>
    isSameProcess(record, table.get(record.pid)),
  );
});
