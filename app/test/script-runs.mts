// Durable proof for the scripts' PTY runs (host/lib/Scripts.ts over the
// node-pty wrapper in scripts/ScriptRuns.ts): real login shells, real
// process groups.
//
// Asserts:
//   - a run that ends on its own reports its exit code and leaves the
//     running list,
//   - a run that finishes while its record is still being written
//     keeps its output and its exit, and leaves the running list,
//   - a cancel takes the run's whole process group down, a child the
//     command started in the background included, and reports the
//     exit as stopped (null), not failed,
//   - a script that ignores SIGTERM is escalated to SIGKILL once the
//     caller's grace is up.
//
// Run: pnpm test script-runs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ScriptEvent } from "@shigomori/contracts/schemas";
import * as Scripts from "@host/lib/Scripts";
import { OrphanSweep } from "@host/lib/scripts/OrphanSweep";
import { initDataDirAt } from "@shared/paths";
import { runHost } from "./lib/hostRuntime.mts";
import { afterAll, beforeAll, it } from "vitest";
import {
  makeTracker,
  processAlive,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import { pidIn } from "../../testProcesses.mts";

const { track, teardown } = makeTracker();
let root: string;

beforeAll(() => {
  root = tempDir("sm-script-runs-", track);
  initDataDirAt(join(root, "data"));
});
afterAll(teardown);

const withScripts = <A, E>(
  body: (scripts: Scripts.Scripts["Service"]) => Effect.Effect<A, E>,
) => runHost(Effect.flatMap(Scripts.Scripts, body));

async function run(
  command: string,
  // The store write behind the orphan sweep's record, the real one
  // unless a proof slows it down, on a Scripts of its own that lasts
  // until the run's exit.
  record?: OrphanSweep["Service"]["record"],
) {
  const events: ScriptEvent[] = [];
  const exit = () => events.find((event) => event.kind === "exit");
  const start = Effect.flatMap(Scripts.Scripts, (scripts) =>
    Effect.gen(function* () {
      const runId = yield* scripts.start({
        command,
        slot: { kind: "package", name: "proof" },
        worktree: { id: "wt", name: "wt", branch: "main", path: root },
        project: { id: "p", path: root, name: "p" },
        notify: (event) => events.push(event),
      });
      if (record !== undefined) {
        yield* Effect.promise(() =>
          waitFor(() => exit() !== undefined, "the run to exit"),
        );
      }
      const listed = () => scripts.list().some((r) => r.runId === runId);
      return { runId, listed };
    }),
  );
  const started = await runHost(
    record === undefined
      ? start
      : Effect.gen(function* () {
          const sweep = yield* OrphanSweep;
          return yield* start.pipe(
            Effect.provide(
              Scripts.layer({
                hurried: () => false,
                env: () => process.env,
              }).pipe(
                Layer.provide(
                  Layer.succeed(
                    OrphanSweep,
                    OrphanSweep.of({ ...sweep, record }),
                  ),
                ),
              ),
            ),
          );
        }),
  );
  return { ...started, events, exit };
}

it("a run that ends reports its code and leaves the list", async () => {
  const { runId, exit, listed } = await run("exit 3");
  await waitFor(() => exit() !== undefined, "the run to exit");
  assert.deepEqual(exit(), { runId, kind: "exit", code: 3 });
  assert.equal(listed(), false);
});

it("a run that finishes while its record is written keeps its output and exit", async () => {
  // The write lasts until the command has exited, the slowest a store
  // can be.
  const { runId, events, exit, listed } = await run(
    "echo quick; exit 4",
    (_, exited) => Effect.asVoid(exited),
  );
  assert.deepEqual(exit(), { runId, kind: "exit", code: 4 });
  assert.match(
    events
      .flatMap((event) => (event.kind === "data" ? [event.data] : []))
      .join(""),
    /quick/,
  );
  assert.equal(listed(), false);
});

it("a cancel takes the whole process group down and reads as stopped", async () => {
  const pidFile = join(root, "background.pid");
  const { runId, exit } = await run(`sleep 60 & echo $! > ${pidFile}; wait`);
  const written = () =>
    existsSync(pidFile) ? pidIn(readFileSync(pidFile, "utf8")) : undefined;
  await waitFor(() => written() !== undefined, "the background child to start");
  const background = written() ?? assert.fail("the background pid went");
  assert.ok(processAlive(background));
  assert.equal(await withScripts((scripts) => scripts.cancel(runId)), true);
  assert.deepEqual(exit(), { runId, kind: "exit", code: null });
  await waitFor(
    () => !processAlive(background),
    "the background child to go with its group",
  );
});

it("a script that ignores SIGTERM is killed when the grace is up", async () => {
  const ready = join(root, "ready");
  const { exit } = await run(
    `trap '' TERM; touch ${ready}; while :; do sleep 1; done`,
  );
  await waitFor(() => existsSync(ready), "the script to arm its trap");
  const started = Date.now();
  await withScripts((scripts) => scripts.stopAll({ graceMs: 300 }));
  await waitFor(() => exit() !== undefined, "the run to exit");
  assert.ok(
    Date.now() - started < 3_000,
    "the kill waited out the default grace instead of the caller's",
  );
});
