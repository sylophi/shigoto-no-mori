// The terminal sm the proofs share, and the engine the host runs on.
// A proof that drives a host module drives the engine in-process, on
// its sandbox's data dir, and reaches the same store from the terminal
// binary where it sets things up or reads them back, as an agent in a
// terminal beside the app would. The binary is the prod flavor's, built
// once per state of its sources (packages/cli/test/lib/binary.ts), so
// the proofs after the first in a run skip the build.
//
// covers: packages/cli/** packages/engine/src/** macfs/**
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Migration from "@shigomori/engine/Migration";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { setSandboxEngine } from "./sandboxEngine.mts";
import {
  ProjectSchema,
  type Project,
} from "@shigomori/contracts/schemas/project";
import { createCliRunner, type CliRunner } from "./checkKit.mts";
import {
  binaryPath,
  builtBinary,
} from "../../../packages/cli/test/lib/binary.ts";

export const smBinaryPath = () => binaryPath("prod");

export const builtSm = () => builtBinary("prod");

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
  const { initDataDirAt } = await import("@shared/paths");
  const Engine = await import("@host/lib/Engine");
  initDataDirAt(dataDir);
  process.env["SHIGOMORI_DATA_DIR"] = dataDir;
  const runtime = ManagedRuntime.make(
    Engine.layer({ flavor: "prod", macfs, sm: "sm" }).pipe(
      Layer.provideMerge(Migration.layer),
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
// plays both sides in one process: an effect given its context runs
// there.
export async function secondEngine(dataDir: string) {
  const Engine = await import("@host/lib/Engine");
  const runtime = ManagedRuntime.make(
    Engine.layer({ flavor: "prod", macfs: builtMacfs(), sm: "sm" }).pipe(
      Layer.provideMerge(Migration.layer),
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
