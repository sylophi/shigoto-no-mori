// The one owner of every test run's temp files. Each runner here (the
// app's proof runner and vitest configs, the packages', the walks', the
// smoke, the scene comparison, the Go tests and the hub's suite through
// `node testTemp.mts`) takes a run folder,
// `<temp>/sm-test/<family>/<id>/`, and points TMPDIR and
// XDG_CONFIG_HOME at it before any test starts, so whatever a test, the
// code under it or a process it spawns puts in the temp dir or the
// config folder lands there. A run removes its folder as
// it exits, and `sm-test` with it once no other run is left. One that
// never gets to (killed, a crash proof's SIGKILL, an interrupted
// `pnpm test`) leaves a folder whose pid file names only dead
// processes, and the next run of any family sweeps it, at its start
// and at its end.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = "SM_TEST_RUN";
const ROOT = "SM_TEST_ROOT";
// How long a run folder with no pid in its file yet counts as one being
// made.
const UNCLAIMED_MS = 2 * 60 * 60_000;

// Takes a run folder for `family` and points this process's TMPDIR at
// it. Inside a run already (a runner that spawns vitest, whose config
// calls this too), joins that run instead, so the run is held while
// either process lives. Returns the run folder.
export function ownTestTemp(family: string): string {
  const inherited = process.env[RUN];
  if (inherited !== undefined && joinRun(inherited)) return inherited;
  const root = process.env[ROOT] ?? join(tmpdir(), "sm-test");
  sweep(root);
  const run = claim(root, family);
  process.env[ROOT] = root;
  process.env[RUN] = run;
  process.env["TMPDIR"] = run;
  // The config folder too, where the engine keeps the data dir's pointer
  // and the data-folder lock beside it (Paths, DataDirLock): the
  // machine's own were one lock for every run here and the plain dev
  // app, so a run's move or settle stalled another's changes.
  const config = join(run, "config");
  mkdirSync(config, { recursive: true });
  process.env["XDG_CONFIG_HOME"] = config;
  process.on("exit", () => {
    if (!heldByOthers(run)) remove(run);
    sweep(root);
  });
  return run;
}

// False when the run is gone: swept after its runner was killed.
function joinRun(run: string): boolean {
  try {
    appendFileSync(join(run, "pid"), `\n${process.pid}`);
    return true;
  } catch {
    return false;
  }
}

function claim(root: string, family: string): string {
  // Another run's sweep may remove the family folder between the two.
  for (;;) {
    mkdirSync(join(root, family), { recursive: true });
    try {
      const run = mkdtempSync(join(root, family, "r"));
      writeFileSync(join(run, "pid"), String(process.pid));
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// Removes every run folder whose processes are gone, then the family
// folders and `root` left empty.
function sweep(root: string): void {
  const now = Date.now();
  for (const family of entries(root)) {
    for (const name of entries(join(root, family))) {
      const run = join(root, family, name);
      if (!held(run, now)) remove(run);
    }
    removeIfEmpty(join(root, family));
  }
  removeIfEmpty(root);
}

function pids(run: string): number[] {
  let text = "";
  try {
    text = readFileSync(join(run, "pid"), "utf8");
  } catch {}
  // 0 would signal this process's group.
  return text
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function held(run: string, now: number): boolean {
  const listed = pids(run);
  if (listed.length > 0) return listed.some(alive);
  try {
    return now - statSync(run).mtimeMs < UNCLAIMED_MS;
  } catch {
    return false;
  }
}

function heldByOthers(run: string): boolean {
  return pids(run).some((pid) => pid !== process.pid && alive(pid));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's live process.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Never throws: two runs may sweep the same folder at once, and a
// process the run left may still be writing into it. A folder a test
// left without write permission can't be emptied, so a removal that
// fails opens every folder up and tries once more.
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    openUp(path);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}

function openUp(dir: string): void {
  try {
    chmodSync(dir, 0o700);
  } catch {
    return;
  }
  for (const name of entries(dir)) {
    const child = join(dir, name);
    try {
      if (lstatSync(child).isDirectory()) openUp(child);
    } catch {}
  }
}

function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {}
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
