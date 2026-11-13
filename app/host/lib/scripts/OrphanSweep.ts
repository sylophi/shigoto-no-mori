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
// then, so the engine's RunningScripts.survivors has to prove the pid is
// still ours before anything is signaled. Every inconclusive answer
// leaves the process alone.
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
import * as ProcessTrees from "./ProcessTrees";

// SIGTERM -> grace -> SIGKILL, same shape as a run's stop (./runs.ts).
// Shorter than the interactive grace: this runs at boot, and a script
// that ignores SIGTERM shouldn't hold the sweep open.
const ORPHAN_GRACE_MS = 2_000;
const EXIT_POLL_MS = 100;

type RecordedScript = RunningScripts.RunningScript;

// Polls instead of waiting on an exit event: these processes are not
// our children any more, so there is nothing to listen to.
const waitForExit = (pid: number, ms: number) =>
  Processes.pidAlive(pid).pipe(
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
  const trees = yield* ProcessTrees.ProcessTrees;
  const tree = { pid: record.pid, ownGroup: record.groupLeader };
  yield* trees.ask(tree, "stop");
  if (yield* waitForExit(record.pid, ORPHAN_GRACE_MS)) return true;
  yield* trees.end(tree);
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
  const ours = yield* RunningScripts.survivors(records);
  if (ours.length === 0) return { stopped: 0 } satisfies OrphanScriptReport;
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
            record.ownerPid === ownerPid ||
            !Processes.isPidAlive(record.ownerPid),
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
