// The one entry point for the proofs in this directory:
//
//   pnpm test                  list them
//   pnpm test socket-host      run test/socket-host.mts
//   pnpm test mirror account   run several, in order, stopping at a failure
//   pnpm test bench/wire       a path under test/ works too
//   pnpm test socket-host --update   flags pass through to the proof
//   pnpm test --all            run every proof, side by side (CI does)
//
// Each proof is a standalone script that exits non-zero when it fails.
// This runner only supplies what they all need from node: the ts-alias
// loader (lib/register-ts-alias.mts), so they can import the app's
// TypeScript through its path aliases, and quiet type-stripping
// warnings. lefthook.yml calls it per job, gated to the files each
// proof covers. `lefthook run pre-commit --all-files` runs the lot.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const testDir = import.meta.dirname;
const SELF = "run.mts";

const SUFFIX = ".mts";

// The proofs, which sit at the top of test/.
function available() {
  return readdirSync(testDir)
    .filter((file) => file !== SELF && file.endsWith(SUFFIX))
    .map((file) => file.slice(0, -SUFFIX.length))
    .toSorted();
}

function resolveTest(name: string): string | null {
  const file = join(testDir, name + SUFFIX);
  return name + SUFFIX !== SELF && existsSync(file) ? file : null;
}

function nodeArgs(file: string, flags: string[]): string[] {
  return [
    "--disable-warning=ExperimentalWarning",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import",
    pathToFileURL(join(testDir, "lib", "register-ts-alias.mts")).href,
    file,
    ...flags,
  ];
}

// Runs `names` side by side, a few at a time, each one's output held
// back and printed whole when it ends so two proofs never interleave.
// Unlike a named run it keeps going past a failure, and names every
// proof that failed at the end.
async function runAll(names: string[], flags: string[]): Promise<number> {
  const failed: string[] = [];
  const queue = [...names];
  const runNext = async (): Promise<void> => {
    const name = queue.shift();
    if (name === undefined) return;
    const started = Date.now();
    const child = spawn(
      process.execPath,
      nodeArgs(join(testDir, name + SUFFIX), flags),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    const status = await new Promise<number | null>((done) =>
      child.on("close", done),
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const verdict = status === 0 ? "ok" : "FAILED";
    if (status !== 0) failed.push(name);
    process.stdout.write(
      `\n== ${name}: ${verdict} (${seconds}s)\n${Buffer.concat(output)}`,
    );
    await runNext();
  };
  const width = Math.min(availableParallelism(), names.length);
  await Promise.all(Array.from({ length: width }, runNext));
  if (failed.length > 0) {
    console.error(`\n${failed.length} failed: ${failed.join(", ")}`);
    return 1;
  }
  console.log(`\nall ${names.length} passed`);
  return 0;
}

// Arguments that start with a dash go to the tests themselves
// (`pnpm test socket-host --update`), except the runner's own.
const args = process.argv.slice(2);
const all = args.includes("--all");
const names = args.filter((arg) => !arg.startsWith("-"));
const flags = args.filter((arg) => arg.startsWith("-") && arg !== "--all");
if (all) {
  process.exit(await runAll(available(), flags));
}
if (names.length === 0) {
  console.log("usage: pnpm test <name>...\n");
  for (const name of available()) console.log(`  ${name}`);
  process.exit(0);
}

for (const name of names) {
  const file = resolveTest(name);
  if (file === null) {
    console.error(`no such test: ${name} (run \`pnpm test\` for the list)`);
    process.exit(2);
  }
  const { status } = spawnSync(process.execPath, nodeArgs(file, flags), {
    stdio: "inherit",
  });
  if (status !== 0) process.exit(status ?? 1);
}
