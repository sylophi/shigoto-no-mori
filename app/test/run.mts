// The one entry point for the proofs in this directory:
//
//   pnpm test                  list them
//   pnpm test socket-host      run test/socket-host.mts
//   pnpm test mirror account   run several, in order, stopping at a failure
//   pnpm test bench/wire       a path under test/ works too
//   pnpm test socket-host --update   flags pass through to the proof
//   pnpm test --all            run every proof, side by side (CI does)
//   pnpm test --changed <path>...    run the proofs (and hub/'s check)
//                                    those files reach
//   pnpm test --changed --list <path>...   name them without running
//
// Each proof is a standalone script that exits non-zero when it fails.
// This runner only supplies what they all need from node: the ts-alias
// loader (lib/register-ts-alias.mts), so they can import the app's
// TypeScript through its path aliases, and quiet type-stripping
// warnings. How `--changed` picks is in README.md.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoRoot } from "./lib/checkKit.mts";
import {
  PRELOAD,
  proofDeps,
  proofFile,
  proofNames,
  reachesHub,
  repoPaths,
  touches,
} from "./lib/proofDeps.mts";

// The warning flags the `test` script runs this with, passed on alone
// (not an --inspect), or the two it sets when run as plain node.
const inherited = process.execArgv.filter((arg) =>
  arg.startsWith("--disable-warning="),
);
const WARNING_FLAGS =
  inherited.length > 0
    ? inherited
    : [
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      ];

function nodeArgs(file: string, flags: string[]): string[] {
  return [
    ...WARNING_FLAGS,
    "--import",
    pathToFileURL(PRELOAD).href,
    file,
    ...flags,
  ];
}

const SM_BUILDER = import.meta.resolve("./lib/smBinary.mts");

// How long `--all` and `--changed` give a check (README.md).
const timeoutMs =
  (Number(process.env.SHIGOMORI_PROOF_TIMEOUT_MINUTES) || 10) * 60_000;

// One build of sm up front, so a cold Go cache doesn't start a build
// per proof, and the proofs find it built. lib/smBinary.mts imports
// through the aliases, so the loader comes first. A failed build is
// reported once, and the proofs that need sm then fail on their own.
async function buildSm(): Promise<void> {
  try {
    await import(pathToFileURL(PRELOAD).href);
    const { builtSm } = await import(SM_BUILDER);
    builtSm();
  } catch (error) {
    console.error("building sm failed, so the proofs that run it will too:");
    console.error(error);
  }
}

type Check = { name: string; command: string; args: string[]; cwd?: string };

function proofCheck(name: string, flags: string[]): Check {
  return {
    name,
    command: process.execPath,
    args: nodeArgs(proofFile(name), flags),
  };
}

// hub/'s typecheck and suite, after its own install (hub/README.md).
const HUB_CHECK: Check = {
  name: "hub",
  command: "sh",
  args: [
    "-c",
    "pnpm -C hub install --frozen-lockfile --prefer-offline && pnpm -C hub run check",
  ],
  cwd: repoRoot,
};

// The slowest checks, started first so they don't make the tail.
const SLOW = new Set(["hub", "sync-transfer", "control", "mirror"]);

// Each check runs in a process group of its own, so a timeout or a
// Ctrl-C takes down everything it started (an sm, a file-sync daemon)
// and not only the check. `running` is what a signal is passed on to.
const running = new Set<ChildProcess>();
let stopping = false;

// Signals the check's whole group. False when nothing in it is left.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

// How long a timed-out check gets to stop on SIGTERM, and an ended one
// to finish writing, before what is left is killed.
const GRACE_MS = 2_000;

// One check with its output held back, and its verdict: "ok",
// "FAILED", or "timed out" once it ran past the timeout and was killed.
async function runHeld(
  check: Check,
): Promise<{ verdict: string; output: Buffer }> {
  const child = spawn(check.command, check.args, {
    cwd: check.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  const closed = new Promise((done) => child.on("close", done));
  const exited = new Promise<number | null>((done) => {
    child.on("exit", done);
    child.on("error", (error) => {
      output.push(Buffer.from(`${error.message}\n`));
      done(null);
    });
  });
  let timedOut = false;
  let killer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup(child, "SIGTERM");
    killer = setTimeout(() => signalGroup(child, "SIGKILL"), GRACE_MS);
  }, timeoutMs);
  // Settled on exit, not on the pipes closing: something the check
  // left running may hold them open.
  const status = await exited;
  clearTimeout(timer);
  clearTimeout(killer);
  await Promise.race([closed, sleep(GRACE_MS, undefined, { ref: false })]);
  if (signalGroup(child, "SIGKILL") && !timedOut) {
    output.push(Buffer.from("(killed what it left running)\n"));
  }
  child.stdout.destroy();
  child.stderr.destroy();
  running.delete(child);
  const verdict = timedOut ? "timed out" : status === 0 ? "ok" : "FAILED";
  return { verdict, output: Buffer.concat(output) };
}

// A signal to the runner stops the queue and goes on to every running
// check (their own groups miss the terminal's Ctrl-C). A second one
// kills them outright.
function forwardSignals(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) {
        for (const child of running) signalGroup(child, "SIGKILL");
        process.exit(130);
      }
      stopping = true;
      for (const child of running) signalGroup(child, signal);
    });
  }
}

// Runs `checks` side by side, a few at a time, each one's output held
// back and printed whole when it ends so two never interleave. Unlike
// a named run it keeps going past a failure, and names every check
// that failed at the end.
async function runAll(checks: Check[]): Promise<number> {
  const smBuilder = relative(repoRoot, fileURLToPath(SM_BUILDER));
  const proofs = checks.filter((check) => check !== HUB_CHECK);
  if (proofs.some(({ name }) => proofDeps(name).files.has(smBuilder))) {
    await buildSm();
  }
  forwardSignals();
  const failed: string[] = [];
  const rank = (name: string) => (SLOW.has(name) ? 0 : 1);
  const queue = checks.toSorted((a, b) => rank(a.name) - rank(b.name));
  const runNext = async (): Promise<void> => {
    const check = queue.shift();
    if (check === undefined || stopping) return;
    const started = Date.now();
    const { verdict, output } = await runHeld(check);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (verdict !== "ok") failed.push(check.name);
    process.stdout.write(
      `\n== ${check.name}: ${verdict} (${seconds}s)\n${output}`,
    );
    await runNext();
  };
  const width = Math.min(availableParallelism(), checks.length);
  await Promise.all(Array.from({ length: width }, runNext));
  if (stopping) {
    console.error("\nstopped");
    return 130;
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} failed: ${failed.join(", ")}`);
    return 1;
  }
  console.log(`\nall ${checks.length} passed`);
  return 0;
}

// The exit status, set rather than exited with, so the output above it
// reaches a pipe (lefthook, CI) whole.
async function main(args: string[]): Promise<number> {
  // Arguments that start with a dash go to the tests themselves
  // (`pnpm test socket-host --update`), except the runner's own.
  const own = new Set(["--all", "--changed", "--list"]);
  const names = args.filter((arg) => !arg.startsWith("-"));
  const flags = args.filter((arg) => arg.startsWith("-") && !own.has(arg));
  // Proofs only: CI checks the hub in a job of its own.
  if (args.includes("--all")) {
    return runAll(proofNames().map((name) => proofCheck(name, flags)));
  }
  if (args.includes("--changed")) {
    const changed = repoPaths(names);
    const checks = proofNames()
      .filter((name) => touches(name, changed))
      .map((name) => proofCheck(name, flags));
    if (reachesHub(changed)) checks.push(HUB_CHECK);
    if (args.includes("--list")) {
      for (const { name } of checks) console.log(name);
      return 0;
    }
    if (checks.length === 0) {
      console.log("no check reaches these files");
      return 0;
    }
    console.log(
      `checks these files reach: ${checks.map((c) => c.name).join(", ")}`,
    );
    return runAll(checks);
  }
  if (names.length === 0) {
    console.log("usage: pnpm test <name>...\n");
    for (const name of proofNames()) console.log(`  ${name}`);
    return 0;
  }
  for (const name of names) {
    const file = proofFile(name);
    if (file === fileURLToPath(import.meta.url) || !existsSync(file)) {
      console.error(`no such test: ${name} (run \`pnpm test\` for the list)`);
      return 2;
    }
    const { status } = spawnSync(process.execPath, nodeArgs(file, flags), {
      stdio: "inherit",
    });
    if (status !== 0) return status ?? 1;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
