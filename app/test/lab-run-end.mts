// What a lab run starts ends with the run, however it ends
// (../lab/lib/runEnd.mts): a process that registers an end and is then
// signalled, exits or forgets it. The end kills what the run started (a
// child here, an app in the lab) and the signal still ends the process.
//
// Run: pnpm test lab-run-end.
//
// covers: app/lab/lib/runEnd.mts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { makeTracker, tempDir, waitFor } from "./lib/checkKit.mts";

const { track, teardown } = makeTracker();
afterEach(teardown);

const runEnd = join(import.meta.dirname, "..", "lab", "lib", "runEnd.mts");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A run that starts a long child, registers an end that kills it, says
// "ready" with the child's pid, then does what `then` says: wait to be
// signalled, exit, or forget the end and exit.
async function run(then: "wait" | "exit" | "forget") {
  const dir = tempDir("lab-run-end-", track);
  const script = join(dir, "run.mts");
  const marker = join(dir, "ended");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { onRunEnd } from ${JSON.stringify(runEnd)};
const child = spawn("sleep", ["600"], { stdio: "ignore" });
const forget = onRunEnd(() => {
  child.kill("SIGKILL");
  writeFileSync(${JSON.stringify(marker)}, "ended");
});
console.log(String(child.pid));
const then = ${JSON.stringify(then)};
if (then === "forget") forget();
if (then !== "wait") process.exit(0);
setInterval(() => {}, 1000);
`,
  );
  const runner = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  runner.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      runner.once("exit", (code, signal) => resolve({ code, signal })),
  );
  track(() => {
    runner.kill("SIGKILL");
  });
  await waitFor(() => out.includes("\n"), "the run to start its child");
  const child = Number(out.trim());
  track(() => {
    if (alive(child)) process.kill(child, "SIGKILL");
  });
  return {
    runner,
    exited,
    child,
    ended: () => existsSync(marker) && readFileSync(marker, "utf8") === "ended",
  };
}

for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  it(`a ${name} ends what the run started, and still ends the run`, async () => {
    const { runner, exited, child, ended } = await run("wait");
    runner.kill(name);
    assert.deepEqual(await exited, { code: null, signal: name });
    assert.ok(ended(), "the end didn't run");
    await waitFor(() => !alive(child), "the run's child to be gone");
  });
}

it("an exit ends what the run started", async () => {
  const { exited, child, ended } = await run("exit");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(ended(), "the end didn't run");
  await waitFor(() => !alive(child), "the run's child to be gone");
});

it("an end the run forgot doesn't run", async () => {
  const { exited, child, ended } = await run("forget");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(!ended(), "a forgotten end ran");
  assert.ok(alive(child), "a forgotten end killed the child");
});
