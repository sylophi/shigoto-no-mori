// Proof for the sweep of what a crash left running
// (host/lib/scripts/OrphanSweep.ts), over the store's record of the
// scripts the app started (the engine's RunningScripts) and real
// process groups:
//   - a script a dead instance recorded, still running as it started,
//     is stopped, and the report says so once,
//   - one whose pid now runs something else is left alone,
//   - a live instance's records are neither swept nor claimed,
//   - a script this instance records leaves the record at its exit,
//   - a script a v2 crash left, named by its running-scripts.json, is
//     stopped by the first v3 start, once.
//
// Run: pnpm test orphan-sweep.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Migration from "@shigomori/engine/Migration";
import * as Paths from "@shigomori/engine/Paths";
import * as Store from "@shigomori/engine/Store";
import * as ConfigProvider from "effect/ConfigProvider";
import * as RunningScripts from "@shigomori/engine/RunningScripts";
import * as HostFacts from "../host/lib/HostFacts.ts";
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

// The sweep as a start brings it up, in a scope of the proof's, over
// the file's store or `scripts`.
// `replaces`: the hosts this one was forked to replace (HostFacts).
async function startSweep(
  scripts?: Layer.Layer<RunningScripts.RunningScripts, unknown>,
  replaces?: { pid: number; startedAt: number }[],
) {
  const scope = Scope.makeUnsafe();
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const host = await hostContext();
  const facts = Context.get(host, HostFacts.HostFacts);
  const fresh = Layer.fresh(OrphanSweep.layer).pipe(
    Layer.provide(
      Layer.succeed(HostFacts.HostFacts, {
        ...facts,
        ...(replaces === undefined ? {} : { replacesHosts: replaces }),
      }),
    ),
  );
  const context = await Effect.runPromise(
    // Fresh: the proof file's runtime holds one built at its start.
    Layer.buildWithScope(
      scripts === undefined ? fresh : fresh.pipe(Layer.provide(scripts)),
      scope,
    ).pipe(Effect.provide(host)),
  );
  return Context.get(context, OrphanSweep.OrphanSweep);
}

// The running scripts over the store of a data dir of its own, opened
// as a start opens it.
const scriptsAt = (dataDir: string) =>
  RunningScripts.layer.pipe(
    Layer.provide(Store.layer((filename) => SqliteClient.make({ filename }))),
    Layer.provide(Migration.layer),
    Layer.provide(Paths.layer("dev")),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { HOME: join(dataDir, ".."), SHIGOMORI_DATA_DIR: dataDir },
        }),
      ),
    ),
    Layer.fresh,
  );

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

it("stops what a script of a host this one replaces left in its group when its leader died, as a package script or a nohup'd command leaves when the host is killed, and leaves alone a group older than its record, another host's, and one a past host of a recycled pid recorded", async () => {
  // Two hosts died since one was last up: `first`, then `crashed`, this
  // one's predecessor.
  const first = await deadPid();
  const crashed = await deadPid();
  const elsewhere = await deadPid();
  const startedAt = Date.now();
  const hostsStarted = startedAt - 1_000;
  const left = await headlessGroup("610");
  const chain = await headlessGroup("611");
  const older = await headlessGroup("612");
  const another = await headlessGroup("613");
  const recycled = await headlessGroup("614");
  const script = { projectId: "p", worktreeId: "wt", command: "pnpm run dev" };
  await runHost(
    Effect.gen(function* () {
      const scripts = yield* RunningScripts.RunningScripts;
      yield* scripts.add({
        ...script,
        runId: "left",
        ownerPid: crashed,
        startedAt,
        pid: left.leader,
      });
      // The host before, which died before it was up to claim it.
      yield* scripts.add({
        ...script,
        runId: "chain",
        ownerPid: first,
        startedAt,
        pid: chain.leader,
      });
      // Recorded as started a minute after what is in the group did.
      yield* scripts.add({
        ...script,
        runId: "older",
        ownerPid: crashed,
        startedAt: Date.now() + 60_000,
        pid: older.leader,
      });
      // Another instance's on the same data dir, or a host's from before a
      // relaunch or a reboot.
      yield* scripts.add({
        ...script,
        runId: "elsewhere",
        ownerPid: elsewhere,
        startedAt,
        pid: another.leader,
      });
      // Written days ago by a host whose pid the crashed one got again.
      yield* scripts.add({
        ...script,
        runId: "recycled",
        ownerPid: crashed,
        startedAt: startedAt - 10 * 24 * 60 * 60 * 1000,
        pid: recycled.leader,
      });
    }),
  );
  const sweep = await startSweep(undefined, [
    { pid: first, startedAt: hostsStarted },
    { pid: crashed, startedAt: hostsStarted },
  ]);
  assert.deepEqual(await Effect.runPromise(sweep.takeReport), { stopped: 2 });
  await waitFor(
    () => !processAlive(left.stray) && !processAlive(chain.stray),
    "the strays to stop",
  );
  assert.ok(
    processAlive(older.stray),
    "a group older than its record was signaled",
  );
  assert.ok(
    processAlive(another.stray),
    "a group another host recorded was signaled",
  );
  assert.ok(
    processAlive(recycled.stray),
    "a group a past host of a recycled pid recorded was signaled",
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

it("stops what a v2 crash left running at the first v3 start, as its running-scripts.json named it, once", async () => {
  const crashed = await deadPid();
  const orphan = leader("620");
  const dataDir = join(
    realpathSync(mkdtempSync(join(tmpdir(), "sm-proof-v2-"))),
    "data",
  );
  track(() => execFileSync("rm", ["-rf", join(dataDir, "..")]));
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "registry.json"), JSON.stringify({}));
  writeFileSync(
    join(dataDir, "running-scripts.json"),
    JSON.stringify({
      ownerPid: crashed,
      scripts: [
        {
          runId: "v2-dev",
          pid: orphan.pid,
          projectId: "p",
          worktreeId: "wt",
          startedAt: Date.now(),
          command: "sleep 620",
        },
        { runId: "unreadable", pid: 1 },
      ],
    }),
  );
  const first = await startSweep(scriptsAt(dataDir));
  assert.deepEqual(await Effect.runPromise(first.takeReport), { stopped: 1 });
  await waitFor(() => !processAlive(orphan.pid), "the v2 orphan to stop");
  // Read once: the rows go with the sweep, though the file stays.
  const left = await Effect.runPromise(
    Effect.flatMap(
      RunningScripts.RunningScripts,
      (scripts) => scripts.list,
    ).pipe(Effect.provide(scriptsAt(dataDir))),
  );
  assert.deepEqual(left, []);
});
