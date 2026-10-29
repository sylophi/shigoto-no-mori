// The terminal binary as its sources are now, for the cli's tests and
// the app's proofs: built once per flavor and state of its sources into
// the run's temp dir (../../../../test/testTemp.mts), keyed by a hash of
// them, with the filesystem helper beside it, where the binary looks. No
// side effects on import.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { flavorNames, type Flavor } from "@shigomori/engine/flavor";
import { isolatedGitEnv } from "../../../../test/gitIsolation.ts";
import { nativefs } from "../../../engine/test/lib/nativefs.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

// What goes into the binary: the sources of the terminal, the engine
// and the contracts, and the filesystem helper's.
const SOURCES = [
  "packages/cli/src",
  "packages/cli/build.mts",
  "packages/engine/src",
  "packages/contracts/src",
  "nativefs",
];

function hashInto(hash: ReturnType<typeof createHash>, rel: string): void {
  const path = join(repoRoot, rel);
  const files = rel.includes(".")
    ? [""]
    : readdirSync(path, { recursive: true })
        .map(String)
        .filter((file) => /\.(ts|mts|go|json|mod|sum)$/.test(file))
        .toSorted();
  for (const file of files) {
    hash.update(`${rel}/${file}\0`);
    hash.update(readFileSync(file === "" ? path : join(path, file)));
  }
}

// Where the binary of `flavor` built from the sources as they are now
// goes.
export function binaryPath(flavor: Flavor): string {
  const hash = createHash("sha256");
  for (const rel of SOURCES) hashInto(hash, rel);
  return join(
    tmpdir(),
    `sm-binary-${flavor}-${hash.digest("hex").slice(0, 16)}`,
    flavorNames(flavor).binaryName,
  );
}

// That binary, built when no earlier test has. Built under a temp name
// and renamed into place, so two building at once both end with a whole
// binary.
export function builtBinary(flavor: Flavor): string {
  const binary = binaryPath(flavor);
  if (existsSync(binary)) return binary;
  const dir = dirname(binary);
  mkdirSync(dir, { recursive: true });
  const helper = join(dir, `nativefs.${process.pid}`);
  copyFileSync(nativefs(), helper);
  renameSync(helper, join(dir, "nativefs"));
  const partial = `${binary}.${process.pid}`;
  execFileSync(process.execPath, ["build.mts", partial, `--flavor=${flavor}`], {
    cwd: join(repoRoot, "packages", "cli"),
    env: isolatedGitEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(partial, binary);
  return binary;
}
