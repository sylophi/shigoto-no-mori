// What a proof or a lab run starts ends with it, however it ends
// (../../testProcesses.mts): a case that fails or times out ends what it
// owns, and a run that exits or is signalled ends everything it started,
// the processes that left its group too, as `sm`'s git does.
//
// Run: pnpm test test-processes.
//
// covers: testProcesses.mts testProcesses.setup.mts
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { endTrees, own } from "../../testProcesses.mts";
import { makeTracker, tempDir } from "./lib/checkKit.mts";

const { track, teardown } = makeTracker();
afterAll(teardown);

const owner = join(import.meta.dirname, "..", "..", "testProcesses.mts");

const pidOf = (child: ChildProcess): number => {
  assert.ok(child.pid !== undefined, `${child.spawnfile} did not start`);
  return child.pid;
};

// As `sm` runs git: a child whose own child is in a session of its own,
// out of the child's group. Answers both pids.
const SM_LIKE = `const c = require("node:child_process").spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
console.log(c.pid);
setInterval(() => {}, 1000);`;

async function smLike(): Promise<{ parent: ChildProcess; grandchild: number }> {
  const parent = own(
    spawn(process.execPath, ["-e", SM_LIKE], {
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const [line] = (await once(parent.stdout, "data")) as [Buffer];
  return { parent, grandchild: Number(line.toString().trim()) };
}

// A run that starts a child and an sm-like child, registers an end that
// only says it ran, prints their pids, then does what `then` says: wait
// to be signalled, exit, or forget the end and exit.
async function run(then: "wait" | "exit" | "forget") {
  const dir = tempDir("test-processes-", track);
  const script = join(dir, "run.mts");
  const marker = join(dir, "ended");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { onRunEnd } from ${JSON.stringify(owner)};
const child = spawn("sleep", ["600"], { stdio: "ignore" });
const parent = spawn(process.execPath, ["-e", ${JSON.stringify(SM_LIKE)}], {
  stdio: ["ignore", "pipe", "inherit"],
});
const [line] = await once(parent.stdout, "data");
const forget = onRunEnd(() => writeFileSync(${JSON.stringify(marker)}, "ended"));
console.log(JSON.stringify([child.pid, parent.pid, Number(String(line).trim())]));
const then = ${JSON.stringify(then)};
if (then === "forget") forget();
if (then !== "wait") process.exit(0);
setInterval(() => {}, 1000);
`,
  );
  const runner = own(
    spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      runner.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const [line] = (await once(runner.stdout, "data")) as [Buffer];
  const pids = JSON.parse(line.toString()) as number[];
  // Not the runner's own tree once it has gone: owned here as well.
  for (const pid of pids) own(pid);
  return {
    runner,
    exited,
    pids,
    ended: () => existsSync(marker) && readFileSync(marker, "utf8") === "ended",
  };
}

// Which of `pids` still run: a zombie has ended, waiting only for its
// parent to read its status.
const running = (pids: readonly number[]): number[] => {
  const listed = spawnSync("ps", ["-o", "pid=,stat=", "-p", pids.join(",")], {
    encoding: "utf8",
  }).stdout;
  return listed
    .split("\n")
    .map((row) => row.trim().split(/\s+/))
    .filter(([pid, stat]) => pid !== "" && !stat?.startsWith("Z"))
    .map(([pid]) => Number(pid));
};

for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  it(`a ${name} runs the run's ends, ends everything it started, and still ends the run`, async () => {
    const { runner, exited, pids, ended } = await run("wait");
    runner.kill(name);
    assert.deepEqual(await exited, { code: null, signal: name });
    assert.ok(ended(), "the end didn't run");
    assert.deepEqual(running(pids), []);
  });
}

it("an exit ends everything the run started", async () => {
  const { exited, pids, ended } = await run("exit");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(ended(), "the end didn't run");
  assert.deepEqual(running(pids), []);
});

it("an end the run forgot doesn't run, and what the run started still ends", async () => {
  const { exited, pids, ended } = await run("forget");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(!ended(), "a forgotten end ran");
  assert.deepEqual(running(pids), []);
});

it("ends a process deaf to SIGTERM and the one it left in a session of its own, and returns once they're gone", async () => {
  const deaf = own(
    spawn("sh", ["-c", "trap '' TERM; sleep 600"], { stdio: "ignore" }),
  );
  const { parent, grandchild } = await smLike();
  endTrees([pidOf(deaf), pidOf(parent)]);
  assert.deepEqual(running([pidOf(deaf), pidOf(parent), grandchild]), []);
});

// This process and every one above it: vitest, pnpm, lefthook under a
// commit, the terminal's job.
function lineage(): number[] {
  const chain: number[] = [];
  for (let pid = process.pid; pid > 1;) {
    chain.push(pid);
    const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout.trim();
    pid = Number(parent);
  }
  return chain;
}

it("ends a child that shares this process's group, and signals neither this process nor any above it", async () => {
  // Not detached: in this fork's group, which is vitest's, and pnpm's
  // and lefthook's above it.
  const child = own(
    spawn("sh", ["-c", "sleep 600 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const [line] = (await once(child.stdout, "data")) as [Buffer];
  const grandchild = Number(line.toString().trim());
  const above = lineage();
  assert.ok(above.length > 1, "no process above this one");
  endTrees([pidOf(child)]);
  assert.deepEqual(running([pidOf(child), grandchild]), []);
  assert.deepEqual(
    running(above),
    above.toSorted((a, b) => a - b),
  );
});

// What the file owns outside its cases outlives them.
let fileOwned: number;
beforeAll(() => {
  fileOwned = pidOf(own(spawn("sleep", ["600"], { stdio: "ignore" })));
});

let leftByFailure: number[] = [];
it.fails("(a case that fails, holding processes)", async () => {
  const { parent, grandchild } = await smLike();
  leftByFailure = [pidOf(parent), grandchild];
  assert.fail("as meant");
});

let leftByTimeout: number[] = [];
it.fails("(a case that runs out of time, holding processes)", async () => {
  const { parent, grandchild } = await smLike();
  leftByTimeout = [pidOf(parent), grandchild];
  await new Promise(() => {});
}, 2_000);

it("a case that failed or ran out of time left nothing it owned running, and the file's own still runs", () => {
  assert.equal(leftByFailure.length, 2);
  assert.equal(leftByTimeout.length, 2);
  assert.deepEqual(running([...leftByFailure, ...leftByTimeout]), []);
  assert.deepEqual(running([fileOwned]), [fileOwned]);
});
