// Durable proof for the owner of the test runs' temp files
// (../../testTemp.mts), on a root of its own. Asserts:
//   - a run's TMPDIR is its folder, and the folder goes as it exits,
//     the parent with it when no other run is left,
//   - a run's folder left by a SIGKILL is swept by the next run,
//   - a live run's folder is not, until its process is gone,
//   - nor is a killed run's that a live process joined,
//   - a process joining a run that was swept takes a run of its own.
//
// Run: pnpm test test-temp.
//
// covers: testTemp.mts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";
import { repoRoot, tempDir } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const owner = pathToFileURL(join(repoRoot, "testTemp.mts")).href;

// How each run ends, once it has printed its folder and its TMPDIR.
const ENDS = {
  exit: "",
  kill: 'process.kill(process.pid, "SIGKILL");',
  hold: "setInterval(() => {}, 1000);",
};

// A run of its own on `root`, not inside this proof's run.
function launch(root: string, end: keyof typeof ENDS, joining?: string) {
  const script = `
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownTestTemp } from ${JSON.stringify(owner)};
const run = ownTestTemp("proof");
writeFileSync(join(tmpdir(), "left"), "");
console.log(run + "\\n" + tmpdir());
${ENDS[end]}
`;
  const env: NodeJS.ProcessEnv = { ...process.env, SM_TEST_ROOT: root };
  if (joining === undefined) delete env["SM_TEST_RUN"];
  else Object.assign(env, { SM_TEST_RUN: joining, TMPDIR: joining });
  return [
    process.execPath,
    ["--input-type=module", "-e", script],
    { env, encoding: "utf8" },
  ] as const;
}

function runTo(root: string, end: "exit" | "kill", joining?: string) {
  const { stdout } = spawnSync(...launch(root, end, joining));
  const [run = "", tmp = ""] = stdout.trim().split("\n");
  assert.notEqual(run, "", "the run printed no folder");
  return { run, tmp };
}

async function holdingRun(root: string, joining?: string) {
  const child = spawn(...launch(root, "hold", joining));
  const exited = once(child, "exit");
  const kill = () => {
    child.kill("SIGKILL");
    return exited;
  };
  trackTest(kill);
  const [out] = await once(child.stdout, "data");
  const [run = "", tmp = ""] = String(out).trim().split("\n");
  return { run, tmp, kill };
}

it("a run's TMPDIR is its folder, which goes as the run exits", () => {
  const root = tempDir("sm-test-temp-", trackTest);
  const { run, tmp } = runTo(root, "exit");
  assert.equal(tmp, run);
  assert.ok(run.startsWith(join(root, "proof")));
  assert.equal(existsSync(root), false);
});

it("a killed run's folder is swept by the next run", () => {
  const root = tempDir("sm-test-temp-", trackTest);
  const killed = runTo(root, "kill");
  assert.equal(existsSync(join(killed.run, "left")), true);
  runTo(root, "exit");
  assert.equal(existsSync(killed.run), false);
});

it("a live run's folder is kept until its process is gone", async () => {
  const root = tempDir("sm-test-temp-", trackTest);
  const live = await holdingRun(root);
  runTo(root, "exit");
  assert.equal(existsSync(join(live.run, "left")), true);
  await live.kill();
  runTo(root, "exit");
  assert.equal(existsSync(live.run), false);
});

it("a killed run's folder is kept while a process that joined it lives", async () => {
  const root = tempDir("sm-test-temp-", trackTest);
  const runner = await holdingRun(root);
  const joined = await holdingRun(root, runner.run);
  assert.equal(joined.run, runner.run);
  assert.equal(joined.tmp, runner.run);
  await runner.kill();
  runTo(root, "exit");
  assert.equal(existsSync(runner.run), true);
  await joined.kill();
  runTo(root, "exit");
  assert.equal(existsSync(runner.run), false);
});

it("a process joining a run that was swept takes a run of its own", () => {
  const root = tempDir("sm-test-temp-", trackTest);
  const gone = join(root, "proof", "rgone");
  const { run, tmp } = runTo(root, "exit", gone);
  assert.notEqual(run, gone);
  assert.equal(tmp, run);
  assert.equal(existsSync(root), false);
});
