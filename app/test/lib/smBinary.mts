// The sm binary every proof that reaches the host's reads needs: the
// host reads rows, projects, config, launchers and scripts through the
// CLI (host/ipc/cliDelegate.ts), so a proof that drives a host module
// drives the real binary too. Built once per state of cli/'s sources
// into the temp dir, keyed by a hash of them, so the proofs after the
// first in a run (and later runs on unchanged sources) skip the build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { ProjectSchema, type Project } from "@shared/schemas/project";
import {
  cliFailureMessage,
  createCliRunner,
  repoRoot,
  type CliRunner,
} from "./checkKit.mts";

const cliDir = join(repoRoot, "cli");

// What goes into the binary: the non-test Go sources, the module files
// and the embedded data. A stray build output (cli/cli) or a test edit
// doesn't change it.
function isBuildInput(rel: string): boolean {
  if (rel.startsWith("embed/")) return true;
  if (rel === "go.mod" || rel === "go.sum") return true;
  return rel.endsWith(".go") && !rel.endsWith("_test.go") && !rel.includes("/");
}

export function smBinaryPath(): string {
  const hash = createHash("sha256");
  const files = readdirSync(cliDir, { recursive: true })
    .map(String)
    .filter(isBuildInput)
    .toSorted();
  for (const rel of files) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(cliDir, rel)));
  }
  return join(tmpdir(), `sm-proof-${hash.digest("hex").slice(0, 16)}`, "sm");
}

// The path of a binary built from cli/ as it is now, building it when
// no earlier proof has. The build lands under a temp name and is
// renamed into place, so two proofs building at once both end with a
// whole binary. No VCS stamp: a hook's GIT_DIR must not reach it.
export function builtSm(): string {
  const binary = smBinaryPath();
  if (existsSync(binary)) return binary;
  mkdirSync(join(binary, ".."), { recursive: true });
  const partial = `${binary}.${process.pid}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  execFileSync("go", ["build", "-buildvcs=false", "-o", partial, "."], {
    cwd: cliDir,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(partial, binary);
  return binary;
}

export type WiredHostCli = CliRunner & {
  binary: string;
  env: NodeJS.ProcessEnv;
};

// Points the host at `dataDir` and at the built binary through the
// CLI runner seam, the way the Electron runner is wired at boot.
// Imported lazily so a proof can scrub its environment before any host
// module loads. `extraEnv` lands on top of the env the binary runs
// under.
export async function wireHostCli(
  dataDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<WiredHostCli> {
  const { initDataDirAt } = await import("@host/lib/util/paths");
  const { setCliRunnerImpl } = await import("@host/ipc/cliDelegate");
  const binary = builtSm();
  const env = { ...process.env, SHIGOMORI_DATA_DIR: dataDir, ...extraEnv };
  initDataDirAt(dataDir);
  const { runCli, sm } = createCliRunner(binary, env);
  setCliRunnerImpl({
    runCli,
    requireCliBinary: () => binary,
    cliFailureMessage,
  });
  return { binary, env, runCli, sm };
}

// Registers a repo as a project through the CLI (`sm` is a runner's),
// answering the CLI's project document, parsed.
export async function addProject(
  sm: CliRunner["sm"],
  path: string,
): Promise<Project> {
  const { docs } = await sm("projects", "add", "--", path);
  const project = docs.findLast((doc) => typeof doc.id === "string");
  assert.ok(project, `projects add emitted no project for ${path}`);
  return ProjectSchema.parse(project);
}
