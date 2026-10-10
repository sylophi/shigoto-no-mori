// The terminal sm the proofs share, and the engine the host runs on.
// A proof that drives a host module drives the engine in-process, on
// its sandbox's data dir, and reaches the same store from the terminal
// binary where it sets things up or reads them back, as an agent in a
// terminal beside the app would. The binary is built once per state of
// its sources into the temp dir, keyed by a hash of them, so the proofs
// after the first in a run (and later runs on unchanged sources) skip
// the build. The darwin helper goes beside it, where the binary looks.
//
// covers: packages/cli/** packages/engine/src/** macfs/**
import * as Schema from "effect/Schema";
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
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { setSandboxEngine } from "./sandboxEngine.mts";
import {
  ProjectSchema,
  type Project,
} from "@shigomori/contracts/schemas/project";
import { createCliRunner, repoRoot, type CliRunner } from "./checkKit.mts";

// What goes into the binary: the sources of the terminal, the engine
// and the contracts, and the darwin helper's.
const SOURCES = [
  "packages/cli/src",
  "packages/cli/build.mts",
  "packages/engine/src",
  "packages/contracts/src",
  "macfs",
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

export function smBinaryPath(): string {
  const hash = createHash("sha256");
  for (const rel of SOURCES) hashInto(hash, rel);
  return join(tmpdir(), `sm-proof-${hash.digest("hex").slice(0, 16)}`, "sm");
}

// The path of a binary built from the sources as they are now, building
// it when no earlier proof has. Built under a temp name and renamed
// into place, so two proofs building at once both end with a whole
// binary.
export function builtSm(): string {
  const binary = smBinaryPath();
  if (existsSync(binary)) return binary;
  const dir = join(binary, "..");
  mkdirSync(dir, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const macfs = join(dir, `macfs.${process.pid}`);
  execFileSync("go", ["build", "-buildvcs=false", "-o", macfs, "."], {
    cwd: join(repoRoot, "macfs"),
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(macfs, join(dir, "macfs"));
  const partial = `${binary}.${process.pid}`;
  execFileSync("node", ["build.mts", partial, "--prod"], {
    cwd: join(repoRoot, "packages", "cli"),
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(partial, binary);
  return binary;
}

// The darwin helper beside the built binary.
function builtMacfs(): string {
  return join(builtSm(), "..", "macfs");
}

export type WiredHostCli = CliRunner & {
  binary: string;
  env: NodeJS.ProcessEnv;
  // Closes the engine, its store with it.
  close: () => Promise<void>;
};

// Points the host at `dataDir` and brings the engine up on it, as the
// app's graph does at launch, until `close`. The terminal
// binary runs on the same data dir. Imported lazily so a proof can
// scrub its environment before any host module loads. `extraEnv` lands
// on top of the env the binary runs under.
export async function wireHostCli(
  dataDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<WiredHostCli> {
  const binary = builtSm();
  const env = { ...process.env, SHIGOMORI_DATA_DIR: dataDir, ...extraEnv };
  const engine = await hostEngine(dataDir, builtMacfs());
  const { runCli, sm } = createCliRunner(binary, env);
  return { binary, env, runCli, sm, close: engine.close };
}

// The host pointed at `dataDir` with the engine up on it, as the app's
// graph does at launch, until `close`. `macfs` only matters to a proof
// that reaches the darwin helper.
export async function hostEngine(dataDir: string, macfs = "macfs") {
  const { initDataDirAt } = await import("@host/lib/util/paths");
  const Engine = await import("@host/lib/engine");
  initDataDirAt(dataDir);
  process.env["SHIGOMORI_DATA_DIR"] = dataDir;
  const runtime = ManagedRuntime.make(
    Engine.adapter.pipe(
      Layer.provideMerge(Engine.layer({ flavor: "prod", macfs, sm: "sm" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  setSandboxEngine(await runtime.context());
  return {
    close: () => {
      setSandboxEngine(undefined);
      return runtime.dispose();
    },
  };
}

// Registers a repo as a project through the terminal binary (`sm` is a
// runner's), answering its project document, parsed.
export async function addProject(
  sm: CliRunner["sm"],
  path: string,
): Promise<Project> {
  const { docs } = await sm("projects", "add", "--", path);
  const project = docs.findLast((doc) => typeof doc.id === "string");
  assert.ok(project, `projects add emitted no project for ${path}`);
  return Schema.decodeUnknownSync(ProjectSchema)(project);
}

// A second device's engine, on a data dir of its own, for a proof that
// plays both sides in one process: what runs inside `Engine.runAside`
// with its runPromise goes there, and so does an effect given its
// context.
export async function secondEngine(dataDir: string) {
  const Engine = await import("@host/lib/engine");
  const runtime = ManagedRuntime.make(
    Engine.layer({ flavor: "prod", macfs: builtMacfs(), sm: "sm" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  // The engine reads the environment as its graph is built.
  const own = process.env["SHIGOMORI_DATA_DIR"];
  process.env["SHIGOMORI_DATA_DIR"] = dataDir;
  try {
    await runtime.context();
  } finally {
    process.env["SHIGOMORI_DATA_DIR"] = own;
  }
  return {
    runPromise: runtime.runPromise,
    // For an effect of the host's to run on, in place of the host's
    // engine (Effect.provide).
    context: () => runtime.context(),
    close: () => runtime.dispose(),
  };
}
