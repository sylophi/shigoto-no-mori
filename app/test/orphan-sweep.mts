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
import { type ChildProcess, spawn } from "node:child_process";
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
