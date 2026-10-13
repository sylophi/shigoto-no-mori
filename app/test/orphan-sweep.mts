// Proof for the sweep of what a crash left running
// (host/lib/scripts/OrphanSweep.ts), over the store's record of the
// scripts the app started (the engine's RunningScripts) and real
// process groups:
//   - a script a dead instance recorded, still running as it started,
//     is stopped, and the report says so once,
//   - one whose pid now runs something else is left alone,
//   - a live instance's records are neither swept nor claimed,
//   - a script this instance records leaves the record at its exit.
//
// Run: pnpm test orphan-sweep.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as RunningScripts from "@shigomori/engine/RunningScripts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterAll, it } from "vitest";
import * as OrphanSweep from "../host/lib/scripts/OrphanSweep.ts";
import { hostContext, runHost } from "./lib/hostRuntime.mts";
import { makeTracker, processAlive, waitFor } from "./lib/checkKit.mts";

const { track, teardown } = makeTracker();
afterAll(teardown);

// A process group of its own, as a script's PTY child leads one.
function leader(seconds: string): ChildProcess & { pid: number } {
  const child = spawn("sleep", [seconds], {
    detached: true,
    stdio: "ignore",
  });
  const { pid } = child;
  assert.ok(pid !== undefined, "sleep did not start");
  track(() => {
    if (processAlive(pid)) process.kill(pid, "SIGKILL");
  });
  return Object.assign(child, { pid });
}

// A group whose leader exited and left a process behind in it, as
// `pnpm run` or a shell does with a nohup'd command when the host is
// killed: the leader's pid, and the one left.
async function headlessGroup(
  seconds: string,
): Promise<{ leader: number; stray: number }> {
  const child = spawn(
    "sh",
    ["-c", `nohup sleep ${seconds} >/dev/null 2>&1 &`],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  const leaderPid = child.pid;
  assert.ok(leaderPid !== undefined, "sh did not start");
  await new Promise((resolve) => child.once("exit", resolve));
  const listed = execFileSync("ps", ["-A", "-o", "pid=,pgid="], {
    encoding: "utf8",
  });
  const stray = listed
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .find(([pid, pgid]) => pgid === leaderPid && pid !== leaderPid)?.[0];
  assert.ok(stray !== undefined, "nothing was left in the group");
  track(() => {
    if (processAlive(stray)) process.kill(stray, "SIGKILL");
  });
  return { leader: leaderPid, stray };
}

// The pid of a process that has exited, as a crashed app's is.
async function deadPid(): Promise<number> {
  const child = spawn("true", { stdio: "ignore" });
  const { pid } = child;
  assert.ok(pid !== undefined, "true did not start");
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

const recorded = () =>
  runHost(
    Effect.flatMap(RunningScripts.RunningScripts, (scripts) => scripts.list),
  );

// The sweep as a start brings it up, in a scope of the proof's.
async function startSweep() {
  const scope = Scope.makeUnsafe();
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const context = await Effect.runPromise(
    // Fresh: the proof file's runtime holds one built at its start.
    Layer.buildWithScope(Layer.fresh(OrphanSweep.layer), scope).pipe(
      Effect.provide(await hostContext()),
    ),
  );
  return Context.get(context, OrphanSweep.OrphanSweep);
}

it("stops what a dead instance left running as it started, leaves a recycled pid and a live instance's scripts alone, and reports once", async () => {
  const crashed = await deadPid();
  const orphan = leader("600");
  const recycled = leader("601");
  const sibling = leader("602");
  const startedAt = Date.now();
  await runHost(
    Effect.gen(function* () {
      const scripts = yield* RunningScripts.RunningScripts;
      const script = {
        projectId: "p",
        worktreeId: "wt",
        startedAt,
      };
      yield* scripts.add({
        ...script,
        runId: "orphan",
        ownerPid: crashed,
        pid: orphan.pid,
        command: "sleep 600",
      });
      // The pid is alive, but not running what was recorded.
      yield* scripts.add({
        ...script,
        runId: "recycled",
        ownerPid: crashed,
        pid: recycled.pid,
        command: "pnpm dev",
      });
      // Another instance, alive: the proof's own parent.
      yield* scripts.add({
        ...script,
        runId: "sibling",
        ownerPid: process.ppid,
        pid: sibling.pid,
        command: "sleep 602",
      });
    }),
  );
  const sweep = await startSweep();
  assert.deepEqual(await Effect.runPromise(sweep.takeReport), { stopped: 1 });
  assert.deepEqual(await Effect.runPromise(sweep.takeReport), { stopped: 0 });
  await waitFor(() => !processAlive(orphan.pid), "the orphan to stop");
  assert.ok(processAlive(recycled.pid), "a stranger's process was signaled");
  assert.ok(processAlive(sibling.pid), "a live instance's script was swept");
  assert.deepEqual(
    (await recorded()).map((script) => script.runId),
    ["sibling"],
    "the dead instance's records were not claimed",
  );
});

it("stops what a script whose leader died left in its group, as a package script or a nohup'd command leaves when the host is killed, and leaves alone a group older than its record and one recorded before this app run", async () => {
  const crashed = await deadPid();
  const startedAt = Date.now();
  const left = await headlessGroup("610");
  const older = await headlessGroup("611");
  const relaunched = await headlessGroup("612");
  await runHost(
    Effect.gen(function* () {
      const scripts = yield* RunningScripts.RunningScripts;
      const script = { projectId: "p", worktreeId: "wt", ownerPid: crashed };
      yield* scripts.add({
        ...script,
        runId: "left",
        startedAt,
        pid: left.leader,
        command: "pnpm run dev",
      });
      // Recorded as started a minute after what is in the group did.
      yield* scripts.add({
        ...script,
        runId: "older",
        startedAt: Date.now() + 60_000,
        pid: older.leader,
        command: "pnpm run dev",
      });
    }),
  );
  // Recorded before the app this host runs under started: a relaunch's
  // or a reboot's sweep, which can be days after the script's group
  // emptied and its id went to a stranger's.
  await runHost(
    Effect.flatMap(RunningScripts.RunningScripts, (scripts) =>
      scripts.add({
        projectId: "p",
        worktreeId: "wt",
        ownerPid: crashed,
        runId: "relaunched",
        startedAt: startedAt - 30 * 24 * 60 * 60 * 1000,
        pid: relaunched.leader,
        command: "pnpm run dev",
      }),
    ),
  );
  const sweep = await startSweep();
  assert.deepEqual(await Effect.runPromise(sweep.takeReport), { stopped: 1 });
  await waitFor(() => !processAlive(left.stray), "the stray to stop");
  assert.ok(
    processAlive(older.stray),
    "a group older than its record was signaled",
  );
  assert.ok(
    processAlive(relaunched.stray),
    "a group recorded before this app run was signaled",
  );
});

it("records a script until its exit", async () => {
  const sweep = await startSweep();
  const exit = Deferred.makeUnsafe<void>();
  await Effect.runPromise(
    sweep.record(
      {
        runId: "mine",
        pid: 4242,
        projectId: "p",
        worktreeId: "wt",
        startedAt: Date.now(),
        command: "pnpm dev",
      },
      Deferred.await(exit),
    ),
  );
  const mine = (await recorded()).find((script) => script.runId === "mine");
  assert.equal(mine?.ownerPid, process.pid);
  Deferred.doneUnsafe(exit, Exit.void);
  await waitFor(
    async () => !(await recorded()).some((script) => script.runId === "mine"),
    "the record to go with the exit",
  );
});
