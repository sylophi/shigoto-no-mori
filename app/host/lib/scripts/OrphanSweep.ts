// Crash recovery for spawned scripts. The runs (../Scripts.ts) are
// memory only, so the quit's stop of every run covers a clean quit and
// nothing else: a force quit, a crash, or an OOM leaves every dev
// server running, reparented to launchd, still holding its port, with
// no UI left to stop it.
//
// So every spawn is recorded in the store (the engine's RunningScripts)
// until its exit, and the next boot sweeps whatever the previous session
// left behind. The record is disposable: a store that can't be read or
// written degrades to sweeping nothing. It never fails a boot, a spawn,
// or an exit.
//
// The dangerous half is the sweep. It works from a record that may be
// days old, and a pid that has been recycled belongs to a stranger by
// then, so isSameProcess below has to prove the pid is still ours
// before anything is signaled. Every inconclusive answer leaves the
// process alone.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type { OrphanScriptReport } from "@shigomori/contracts/schemas";
import * as RunningScripts from "@shigomori/engine/RunningScripts";
import * as Processes from "@shigomori/engine/processes";
import { signalPidTree, signalTree } from "./process";

// `ps` reports a start time to the second and we stamp startedAt just
// after spawn returns, so the two differ by that rounding plus spawn
// latency. Generous enough for a loaded machine, still orders of
// magnitude tighter than any plausible pid reuse.
const START_TOLERANCE_MS = 5_000;
// SIGTERM -> grace -> SIGKILL, same shape as a run's stop (./runs.ts).
// Shorter than the interactive grace: this runs at boot, and a script
// that ignores SIGTERM shouldn't hold the sweep open.
const ORPHAN_GRACE_MS = 2_000;
const EXIT_POLL_MS = 100;

type RecordedScript = RunningScripts.RunningScript;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and simply isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LiveProcess {
  pid: number;
  pgid: number;
  startedAt: number;
  command: string;
}

// "  1234  1234 Mon Aug 17 18:42:41 2026 /bin/zsh -l -c pnpm dev"
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/;

function parseProcessTable(stdout: string): LiveProcess[] {
  const rows: LiveProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const [, pidText, pgidText, startedText, command] = match;
    if (
      pidText === undefined ||
      pgidText === undefined ||
      startedText === undefined ||
      command === undefined
    ) {
      continue;
    }
    const startedAt = Date.parse(startedText);
    if (Number.isNaN(startedAt)) continue;
    rows.push({
      pid: Number(pidText),
      pgid: Number(pgidText),
      startedAt,
      command: command.trim(),
    });
  }
  return rows;
}

// -ww so a long dev-server command line isn't truncated, LC_ALL so
// lstart's month and day names stay parseable.
const PS_COLUMNS = ["-ww", "-o", "pid=,pgid=,lstart=,command="];
const PS_ENV = { env: { LC_ALL: "C" }, extendEnv: true };

const readProcessTable = Effect.fnUntraced(function* (pids: number[]) {
  const table = new Map<number, LiveProcess>();
  if (pids.length === 0) return table;
  const listed = yield* Processes.exec(
    "ps",
    ["-p", pids.join(","), ...PS_COLUMNS],
    PS_ENV,
  ).pipe(Effect.option);
  // `ps` exits non-zero when none of the pids are live, which is the
  // ordinary "they all died with the app" case. A genuine failure to
  // run it lands here too and leaves the table empty, so nothing gets
  // signaled, which is the safe direction.
  if (Option.isNone(listed)) return table;
  for (const row of parseProcessTable(listed.value.stdout)) {
    table.set(row.pid, row);
  }
  return table;
});

// The recorded command is what we handed the login shell, but a shell
// execs into the last command of what it runs, so the live command
// line is often one program with its own argv: `pnpm i && pnpm dev`
// shows up as `node .../pnpm.cjs dev`, and a shell-quoted absolute
// path loses its quotes. Accept the whole recorded command, or the
// program of any command in it (past its `NAME=value` words and an
// `exec`, which aren't in the live line), or that program's basename,
// and treat anything else as inconclusive.
function commandMatches(recorded: string, live: string): boolean {
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
}

// The identity proof. A live pid says nothing on its own, so three
// independent facts have to agree before the sweep signals anything:
// the process leads its own group when it did (a script's PTY child
// leads a session of its own, and setsid survives an exec, while a
// lifecycle script ran in the app's group), it started when we recorded
// that it started, and its command line still looks like the one we
// launched.
function isSameProcess(
  record: RecordedScript,
  live: LiveProcess | undefined,
): boolean {
  if (!live) return false;
  if (record.groupLeader !== (live.pgid === live.pid)) return false;
  if (Math.abs(live.startedAt - record.startedAt) > START_TOLERANCE_MS) {
    return false;
  }
  return commandMatches(record.command, live.command);
}

// Polls instead of waiting on an exit event: these processes are not
// our children any more, so there is nothing to listen to.
const waitForExit = (pid: number, ms: number) =>
  Effect.sync(() => isProcessAlive(pid)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(EXIT_POLL_MS)),
      while: (alive) => alive,
    }),
    Effect.delay(Duration.millis(EXIT_POLL_MS)),
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.map(Option.isSome),
  );

// A lifecycle script's group is the dead app's, which its other
// leftovers share, so only its own tree is signaled.
const killOrphan = Effect.fnUntraced(function* (record: RecordedScript) {
  const signal = record.groupLeader ? signalTree : signalPidTree;
  yield* signal(record.pid, "SIGTERM");
  if (yield* waitForExit(record.pid, ORPHAN_GRACE_MS)) return true;
  yield* signal(record.pid, "SIGKILL");
  const died = yield* waitForExit(record.pid, ORPHAN_GRACE_MS);
  if (!died) {
    yield* Effect.logWarning(
      `[scripts] orphaned pid ${record.pid} survived SIGKILL, leaving it alone`,
    );
  }
  return died;
});

// Survivors get killed rather than adopted back into the UI. Their
// stdio pipes died with the host process that owned them, so there is
// no output left to stream and no console history to restore, and a
// row the user can only stop is worse than the invariant that what the
// UI shows is what is running. Killing also frees the ports the next
// run of the same script needs.
const reapOrphans = Effect.fnUntraced(function* (
  records: readonly RecordedScript[],
) {
  const none: OrphanScriptReport = { stopped: 0 };
  if (records.length === 0) return none;
  const table = yield* readProcessTable(records.map((r) => r.pid));
  const ours = records.filter((r) => isSameProcess(r, table.get(r.pid)));
  if (ours.length === 0) return none;
  const outcomes = yield* Effect.forEach(ours, killOrphan, {
    concurrency: "unbounded",
  });
  const stopped = outcomes.filter(Boolean).length;
  yield* Effect.logWarning(
    `[scripts] stopped ${stopped} of ${ours.length} script(s) left running by a previous session`,
  );
  return { stopped } satisfies OrphanScriptReport;
});

// The sweep of what a crash, a force quit or an OOM left running, which
// skipped the quit's reap, and the record it sweeps from. Its layer
// claims the previous sessions' records at boot, before any script can
// spawn, and kills in the background. Another live instance's records
// are not ours: two instances pointed at the same data dir (a dev build
// launched with SHIGOMORI_DATA_DIR aimed at the packaged data dir) would
// otherwise have the second one's sweep kill the first one's live
// scripts out from under its window.
export class OrphanSweep extends Context.Service<
  OrphanSweep,
  {
    // The sweep's report, once, for the renderer's notice: it waits for
    // the sweep rather than sampling it, since the window regularly
    // finishes loading before a survivor has finished dying, and a
    // report that came back empty for that reason would drop the
    // notice. Every later ask answers nothing stopped.
    readonly takeReport: Effect.Effect<OrphanScriptReport>;
    // Records a script this instance started, until `exit` says it is
    // gone.
    readonly record: (
      script: Omit<RecordedScript, "ownerPid">,
      exit: Effect.Effect<unknown>,
    ) => Effect.Effect<void>;
  }
>()("sm/host/OrphanSweep") {}

// Losing the record costs the next boot's sweep and nothing else.
const recordFailure = (what: string) =>
  Effect.ignoreCause({
    log: "Warn",
    message: `[scripts] couldn't ${what} running scripts`,
  });

export const layer = Layer.effect(
  OrphanSweep,
  Effect.gen(function* () {
    const recorded = yield* RunningScripts.RunningScripts;
    const scope = yield* Effect.scope;
    const ownerPid = process.pid;
    // Ours: a dead instance's, or this pid's from a session before. A
    // live instance's are running right now, with a window attached.
    const left = yield* recorded.list.pipe(
      Effect.map((records) =>
        records.filter(
          (record) =>
            record.ownerPid === ownerPid || !isProcessAlive(record.ownerPid),
        ),
      ),
      Effect.tap((records) => recorded.remove(records.map((r) => r.runId))),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "[scripts] couldn't read running scripts",
          cause,
        ).pipe(Effect.as([])),
      ),
    );
    const done = yield* Deferred.make<OrphanScriptReport>();
    yield* reapOrphans(left).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("[scripts] orphan sweep failed", cause).pipe(
          Effect.as({ stopped: 0 }),
        ),
      ),
      Effect.flatMap((report) => Deferred.succeed(done, report)),
      Effect.forkScoped,
    );
    const reported = yield* Ref.make(false);
    return OrphanSweep.of({
      takeReport: Ref.getAndSet(reported, true).pipe(
        Effect.flatMap((was) =>
          was ? Effect.succeed({ stopped: 0 }) : Deferred.await(done),
        ),
        Effect.withSpan("OrphanSweep.takeReport"),
      ),
      record: Effect.fn("OrphanSweep.record")(function* (
        script: Omit<RecordedScript, "ownerPid">,
        exit: Effect.Effect<unknown>,
      ) {
        yield* recorded
          .add({ ...script, ownerPid })
          .pipe(recordFailure("record"));
        yield* exit.pipe(
          Effect.andThen(recorded.remove([script.runId])),
          recordFailure("update"),
          Effect.forkIn(scope),
        );
      }),
    });
  }),
);
