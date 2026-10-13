// Crash recovery for spawned scripts. `runningScripts` in ./index.ts is
// memory only, so the quit's reap in host/process/layer.ts covers a clean quit
// and nothing else: a force quit, a crash, or an OOM leaves every dev
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
import * as HostFacts from "@host/lib/HostFacts";
import * as Processes from "@shigomori/engine/processes";
import { signalTree } from "./process";

// `ps` reports a start time to the second and we stamp startedAt just
// after spawn returns, so the two differ by that rounding plus spawn
// latency. Generous enough for a loaded machine, still orders of
// magnitude tighter than any plausible pid reuse.
const START_TOLERANCE_MS = 5_000;
// SIGTERM -> grace -> SIGKILL, same shape as killRecord in ./index.ts.
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

// "  1234  1234 Mon Aug 17 18:42:41 2026"
const GROUP_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s*$/;

type GroupMember = Omit<LiveProcess, "command">;

// Every process's group and start, for the groups a script's dead
// leader left: no command lines, so a machine running thousands of
// processes with long ones still fits what `ps` may answer. Null when
// `ps` could not be run, which signals nothing.
const readAllGroups = Effect.fnUntraced(function* () {
  const listed = yield* Processes.exec(
    "ps",
    ["-A", "-o", "pid=,pgid=,lstart="],
    PS_ENV,
  ).pipe(Effect.option);
  if (Option.isNone(listed)) return null;
  const rows: GroupMember[] = [];
  for (const line of listed.value.stdout.split("\n")) {
    const match = GROUP_LINE.exec(line);
    if (!match) continue;
    const [, pidText, pgidText, startedText] = match;
    if (
      pidText === undefined ||
      pgidText === undefined ||
      startedText === undefined
    ) {
      continue;
    }
    const startedAt = Date.parse(startedText);
    if (Number.isNaN(startedAt)) continue;
    rows.push({ pid: Number(pidText), pgid: Number(pgidText), startedAt });
  }
  return rows;
});

// The recorded command is what we handed the login shell, but a shell
// running a single simple command execs into it, so the live command
// line is often the program with its own argv: `pnpm dev` shows up as
// `node .../pnpm.cjs dev`, and a shell-quoted absolute path loses its
// quotes. Accept the whole recorded command, its leading word, or that
// word's basename, and treat anything else as inconclusive.
function commandMatches(recorded: string, live: string): boolean {
  const trimmed = recorded.trim();
  if (trimmed === "") return false;
  if (live.includes(trimmed)) return true;
  const head = (trimmed.split(/\s+/)[0] ?? "").replace(/['"]/g, "");
  if (head === "") return false;
  return (
    live.includes(head) || live.includes(head.slice(head.lastIndexOf("/") + 1))
  );
}

// The identity proof. A live pid says nothing on its own, so three
// independent facts have to agree before the sweep signals anything:
// the process leads its own group (a script's PTY child leads a session of its own, and
// setsid survives an exec), it started when we recorded that it
// started, and its command line still looks like the one we launched.
function isSameProcess(
  record: RecordedScript,
  live: LiveProcess | undefined,
): boolean {
  if (!live) return false;
  if (live.pgid !== live.pid) return false;
  if (Math.abs(live.startedAt - record.startedAt) > START_TOLERANCE_MS) {
    return false;
  }
  return commandMatches(record.command, live.command);
}

// The proof for a group whose leader is gone. It holds only for a
// script one of the hosts this one replaces wrote while it ran
// (HostFacts.replacesHosts), which exited moments before: the system
// hands out no pid while a group of that id lives, so the group under the
// recorded pid is the script's, unless the script's group emptied and a
// stranger's took its id since, which takes far longer than a respawn.
// Another instance's records on the same data dir, those from before a
// relaunch or a reboot, and one an earlier host of a recycled pid wrote,
// can be days old, so their groups are left alone. Every member must
// have started after the script did.
type Replaced = readonly { readonly pid: number; readonly startedAt: number }[];

function isSameGroup(
  record: RecordedScript,
  members: readonly GroupMember[],
  replaced: Replaced,
): boolean {
  return (
    isReplacedHosts(record, replaced) &&
    !members.some((member) => member.pid === record.pid) &&
    members.length > 0 &&
    members.every(
      (member) => member.startedAt >= record.startedAt - START_TOLERANCE_MS,
    )
  );
}

const isReplacedHosts = (record: RecordedScript, replaced: Replaced) =>
  replaced.some(
    (host) =>
      host.pid === record.ownerPid &&
      record.startedAt >= host.startedAt - START_TOLERANCE_MS,
  );

const membersOf = (all: readonly GroupMember[], pgid: number) =>
  all.filter((row) => row.pgid === pgid);

function isGroupAlive(pgid: number): boolean {
  return isProcessAlive(-pgid);
}

// Polls instead of waiting on an exit event: these processes are not
// our children any more, so there is nothing to listen to.
const waitForExit = (pid: number, ms: number) =>
  waitUntilGone(() => isProcessAlive(pid), ms);

const waitUntilGone = (isAlive: () => boolean, ms: number) =>
  Effect.sync(isAlive).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(EXIT_POLL_MS)),
      while: (alive) => alive,
    }),
    Effect.delay(Duration.millis(EXIT_POLL_MS)),
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.map(Option.isSome),
  );

// A group whose leader is gone, signaled as a group: SIGTERM, then
// SIGKILL to what is still ours after the grace.
const killStrays = Effect.fnUntraced(function* (
  record: RecordedScript,
  replaced: Replaced,
) {
  const pgid = record.pid;
  yield* signalTree(pgid, "SIGTERM");
  if (yield* waitUntilGone(() => isGroupAlive(pgid), ORPHAN_GRACE_MS)) {
    return true;
  }
  const all = yield* readAllGroups();
  if (all === null || !isSameGroup(record, membersOf(all, pgid), replaced)) {
    return true;
  }
  yield* signalTree(pgid, "SIGKILL");
  const died = yield* waitUntilGone(() => isGroupAlive(pgid), ORPHAN_GRACE_MS);
  if (!died) {
    yield* Effect.logWarning(
      `[scripts] the orphaned group ${pgid} survived SIGKILL, leaving it alone`,
    );
  }
  return died;
});

const killOrphan = Effect.fnUntraced(function* (record: RecordedScript) {
  yield* signalTree(record.pid, "SIGTERM");
  if (yield* waitForExit(record.pid, ORPHAN_GRACE_MS)) return true;
  // Still alive after the grace period, or the number was freed and
  // taken over in the meantime. Re-prove the identity before escalating
  // so SIGKILL can't chase whatever inherited the pid.
  const table = yield* readProcessTable([record.pid]);
  if (!isSameProcess(record, table.get(record.pid))) return true;
  yield* signalTree(record.pid, "SIGKILL");
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
  replaced: Replaced,
) {
  const none: OrphanScriptReport = { stopped: 0 };
  if (records.length === 0) return none;
  const table = yield* readProcessTable(records.map((r) => r.pid));
  const ours = records.filter((r) => isSameProcess(r, table.get(r.pid)));
  // A leader gone with its group still going, for the replaced hosts'
  // scripts alone.
  const theirs = records.filter((r) => isReplacedHosts(r, replaced));
  const all = theirs.length === 0 ? [] : yield* readAllGroups();
  const strays =
    all === null
      ? []
      : theirs.filter((r) => isSameGroup(r, membersOf(all, r.pid), replaced));
  const found = ours.length + strays.length;
  if (found === 0) return none;
  const outcomes = yield* Effect.all(
    [
      Effect.forEach(ours, killOrphan, { concurrency: "unbounded" }),
      Effect.forEach(strays, (record) => killStrays(record, replaced), {
        concurrency: "unbounded",
      }),
    ],
    { concurrency: "unbounded" },
  );
  const stopped = outcomes.flat().filter(Boolean).length;
  yield* Effect.logWarning(
    `[scripts] stopped ${stopped} of ${found} script(s) left running by a previous session`,
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
    const facts = yield* HostFacts.HostFacts;
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
    yield* reapOrphans(left, facts.replacesHosts ?? []).pipe(
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
