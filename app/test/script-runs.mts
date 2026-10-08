// Durable proof for the scripts' PTY runs (host/lib/scripts/index.ts
// over the node-pty wrapper in pty.ts): real login shells, real process
// groups.
//
// Asserts:
//   - a run that ends on its own reports its exit code and leaves the
//     running list,
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
import type { ScriptEvent } from "@shigomori/contracts/schemas";
import {
  cancelScript,
  killAllScripts,
  listRunningScripts,
  startScript,
} from "@host/lib/scripts";
import { initDataDirAt } from "@host/lib/util/paths";
import { afterAll, beforeAll, it } from "vitest";
import {
  makeTracker,
  processAlive,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";

const { track, teardown } = makeTracker();
let root: string;

beforeAll(() => {
  root = tempDir("sm-script-runs-", track);
  initDataDirAt(join(root, "data"));
});
afterAll(teardown);

function run(command: string) {
  const events: ScriptEvent[] = [];
  const runId = startScript({
    command,
    slot: { kind: "package", name: "proof" },
    worktree: { id: "wt", name: "wt", branch: "main", path: root },
    project: { id: "p", path: root, name: "p" },
    notify: (event) => events.push(event),
  });
  const exit = () => events.find((event) => event.kind === "exit");
  return { runId, events, exit };
}

it("a run that ends reports its code and leaves the list", async () => {
  const { runId, exit } = run("exit 3");
  await waitFor(() => exit() !== undefined, "the run to exit");
  assert.deepEqual(exit(), { runId, kind: "exit", code: 3 });
  assert.ok(listRunningScripts().every((script) => script.runId !== runId));
});

it("a cancel takes the whole process group down and reads as stopped", async () => {
  const pidFile = join(root, "background.pid");
  const { runId, exit } = run(`sleep 60 & echo $! > ${pidFile}; wait`);
  await waitFor(() => existsSync(pidFile), "the background child to start");
  const background = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(processAlive(background));
  assert.equal(await cancelScript(runId), true);
  assert.deepEqual(exit(), { runId, kind: "exit", code: null });
  await waitFor(
    () => !processAlive(background),
    "the background child to go with its group",
  );
});

it("a script that ignores SIGTERM is killed when the grace is up", async () => {
  const ready = join(root, "ready");
  const { exit } = run(
    `trap '' TERM; touch ${ready}; while :; do sleep 1; done`,
  );
  await waitFor(() => existsSync(ready), "the script to arm its trap");
  const started = Date.now();
  await killAllScripts({ graceMs: 300 });
  await waitFor(() => exit() !== undefined, "the run to exit");
  assert.ok(
    Date.now() - started < 3_000,
    "the kill waited out the default grace instead of the caller's",
  );
});
