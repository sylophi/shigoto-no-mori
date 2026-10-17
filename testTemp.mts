// The one owner of every test run's temp files. Each runner here (the
// app's proof runner and vitest configs, the packages', the walks', the
// smoke, the Go tests through `node testTemp.mts`) takes a run folder,
// `<temp>/sm-test/<family>/<id>/`, and points TMPDIR at it before any
// test starts, so whatever a test, the code under it or a process it
// spawns puts in the temp dir lands there. A run removes its folder as
// it exits. One that never gets to (killed, a crash proof's SIGKILL, an
// interrupted `pnpm test`) leaves a folder whose pid file names a dead
// process, and the next run of any family sweeps it, at its start and
// at its end.
//
// `cache/` beside the families holds what outlives a run on purpose
// (the proofs' sm and macfs binaries), swept once nothing has used an
// entry for STALE_MS.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = "SM_TEST_RUN";
const ROOT = "SM_TEST_ROOT";
const STALE_MS = 2 * 60 * 60_000;

// `<temp>/sm-test`, the system temp dir's even inside a run, where
// TMPDIR is the run's folder.
const testTempRoot = (): string =>
  process.env[ROOT] ?? join(tmpdir(), "sm-test");

// A folder for what outlives a run, `cache/<name>`, swept once unused
// for STALE_MS. Asking for it is a use.
export function testCacheDir(name: string): string {
  const dir = join(testTempRoot(), "cache", name);
  const now = new Date();
  try {
    utimesSync(dir, now, now);
  } catch {}
  return dir;
}

// Takes a run folder for `family` and points this process's TMPDIR at
// it, unless a run already owns this process tree (a runner that spawns
// vitest, whose config calls this too). Returns the run folder.
export function ownTestTemp(family: string): string {
  const owned = process.env[RUN];
  if (owned !== undefined) return owned;
  const root = testTempRoot();
  sweepTestTemp(root);
  mkdirSync(join(root, family), { recursive: true });
  const run = mkdtempSync(join(root, family, "r"));
  writeFileSync(join(run, "pid"), String(process.pid));
  process.env[ROOT] = root;
  process.env[RUN] = run;
  process.env["TMPDIR"] = run;
  process.on("exit", () => {
    remove(run);
    sweepTestTemp(root);
  });
  return run;
}

// Removes every run folder whose process is gone, and every cache entry
// unused for STALE_MS. A run folder with no pid in its file yet is one
// being made, unless it is older than STALE_MS.
function sweepTestTemp(root = testTempRoot()): void {
  const now = Date.now();
  for (const family of entries(root)) {
    if (family === "cache") continue;
    for (const name of entries(join(root, family))) {
      const run = join(root, family, name);
      if (!held(run, now)) remove(run);
    }
  }
  for (const name of entries(join(root, "cache"))) {
    const entry = join(root, "cache", name);
    if (olderThanStale(entry, now)) remove(entry);
  }
}

function held(run: string, now: number): boolean {
  let pid = 0;
  try {
    pid = Number(readFileSync(join(run, "pid"), "utf8"));
  } catch {}
  // Not yet written, and 0 would signal this process's group.
  if (!Number.isInteger(pid) || pid <= 0) return !olderThanStale(run, now);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's live process.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Never throws: two runs may sweep the same folder at once, and a
// process the run left may still be writing into it.
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}

function olderThanStale(path: string, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// `node testTemp.mts <family> <command> [args...]` runs a command in a
// run folder of its own, for a suite with no runner of ours (go test).
if (import.meta.main) {
  const [family, command, ...args] = process.argv.slice(2);
  if (family === undefined || command === undefined) {
    console.error("usage: node testTemp.mts <family> <command> [args...]");
    process.exit(2);
  }
  ownTestTemp(family);
  const { status } = spawnSync(command, args, { stdio: "inherit" });
  process.exitCode = status ?? 1;
}
