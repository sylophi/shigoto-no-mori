// The one entry point for the proofs in this directory, which run under
// vitest (../vitest.config.ts):
//
//   pnpm test                  run every proof (CI does)
//   pnpm test socket-host      run test/socket-host.mts
//   pnpm test mirror account   run several
//   pnpm test socket-host -u   flags pass through to vitest
//   pnpm test bench/wire       a script under bench/ runs under node
//   pnpm test --changed <path>...   run the proofs those files reach
//
// How `--changed` picks is in README.md.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appRoot, repoRoot } from "./lib/checkKit.mts";
import { coveringFiles } from "./lib/covers.mts";

const VITEST = join(appRoot, "node_modules", ".bin", "vitest");

function run(command: string, args: string[]): number {
  const { status } = spawnSync(command, args, {
    cwd: appRoot,
    stdio: "inherit",
  });
  return status ?? 1;
}

// A bench script is not a proof: it runs as a plain script, under the
// alias loader for the app's TypeScript.
function runScript(name: string, flags: string[]): number {
  const loader = join(import.meta.dirname, "lib", "register-ts-alias.mts");
  return run(process.execPath, [
    ...process.execArgv,
    "--import",
    pathToFileURL(loader).href,
    join(import.meta.dirname, `${name}.mts`),
    ...flags,
  ]);
}

// `vitest related` runs the proofs that import a changed file, however
// deep. The files whose covers lines match a changed path join the
// list, so a change reaches the proofs that read it off disk, scan it
// or build it too.
function runChanged(paths: string[], flags: string[]): number {
  const changed = paths.map((path) =>
    relative(repoRoot, resolve(repoRoot, path)),
  );
  const related = [...new Set([...changed, ...coveringFiles(changed)])];
  return run(VITEST, [
    "related",
    "--run",
    "--passWithNoTests",
    ...related.map((path) => join(repoRoot, path)),
    ...flags,
  ]);
}

function main(args: string[]): number {
  const names = args.filter((arg) => !arg.startsWith("-"));
  const flags = args.filter(
    (arg) => arg.startsWith("-") && arg !== "--changed",
  );
  if (args.includes("--changed")) return runChanged(names, flags);
  for (const name of names) {
    if (!existsSync(join(import.meta.dirname, `${name}.mts`))) {
      console.error(`no such test: ${name}`);
      return 2;
    }
  }
  if (names.length === 1 && names[0]?.startsWith("bench/")) {
    return runScript(names[0], flags);
  }
  // A filter is a substring of the file's path, so the full name keeps
  // `mirror` from also running mirror-status.
  // Names before flags: `-u` takes an optional value, and would read
  // a name after it as one.
  return run(VITEST, ["run", ...names.map((n) => `test/${n}.mts`), ...flags]);
}

process.exitCode = main(process.argv.slice(2));
