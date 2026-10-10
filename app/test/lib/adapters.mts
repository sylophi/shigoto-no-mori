// Every proof's file runs with the Promise adapters of the converted
// subsystems up, the way the app's graph (host/process/layer.ts) brings
// them up, so host code a proof reaches answers instead of waiting
// for a graph that never comes (EFFECT.md, runtime boundaries).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, beforeAll } from "vitest";
import * as FileSync from "../../host/fileSync/FileSync.ts";
import * as Engine from "../../host/lib/engine.ts";
import * as GithubCli from "../../host/lib/githubCli/GithubCli.ts";
import * as Ports from "../../host/lib/ports.ts";
import * as ScriptRuns from "../../host/lib/scripts/pty.ts";
import * as Processes from "../../host/lib/util/processes.ts";
import * as Villagers from "../../host/lib/villagers.ts";

// The engine's data dir for this file's proofs, a fresh one each file.
// A proof that drives the host's engine calls points the host's own
// data dir (initDataDirAt) at it too.
export const engineDataDir = join(
  realpathSync(mkdtempSync(join(tmpdir(), "sm-proof-data-"))),
  "data",
);

// The darwin helper as macfs/ is now, built once per state of its
// sources into the temp dir, as smBinary.mts builds sm.
function builtMacfs(): string {
  const dir = join(import.meta.dirname, "..", "..", "..", "macfs");
  const hash = createHash("sha256");
  for (const rel of readdirSync(dir)
    .filter(
      (file) =>
        file === "go.mod" ||
        file === "go.sum" ||
        (file.endsWith(".go") && !file.endsWith("_test.go")),
    )
    .toSorted()) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(dir, rel)));
  }
  const binary = join(
    tmpdir(),
    `macfs-proof-${hash.digest("hex").slice(0, 16)}`,
    "macfs",
  );
  if (existsSync(binary)) return binary;
  mkdirSync(join(binary, ".."), { recursive: true });
  const partial = `${binary}.${process.pid}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  execFileSync("go", ["build", "-buildvcs=false", "-o", partial, "."], {
    cwd: dir,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(partial, binary);
  return binary;
}

// The engine reads its data dir from the environment when the graph
// is built (host/lib/engine.ts). Set here, so a proof never writes to
// the dev app's, or to one the shell exported.
process.env.SHIGOMORI_DATA_DIR = engineDataDir;
const engine = Engine.adapter.pipe(
  Layer.provideMerge(
    Engine.layer({ flavor: "dev", macfs: builtMacfs(), sm: "smd" }),
  ),
);

// No file-sync engine: a proof that runs one brings its own
// (mirror.mts).
const runtime = ManagedRuntime.make(
  Processes.adapter.pipe(
    Layer.provideMerge(ScriptRuns.adapter),
    Layer.provideMerge(ScriptRuns.layer),
    Layer.provideMerge(FileSync.adapter),
    Layer.provideMerge(FileSync.layer(() => null)),
    Layer.provideMerge(GithubCli.adapter),
    Layer.provideMerge(GithubCli.layer),
    Layer.provideMerge(Ports.adapter),
    Layer.provideMerge(Ports.layer),
    Layer.provideMerge(Villagers.adapter),
    Layer.provideMerge(Villagers.deviceLayer),
    Layer.provideMerge(engine),
    Layer.provideMerge(NodeServices.layer),
  ),
);

beforeAll(() => runtime.context());
afterAll(async () => {
  await runtime.dispose();
  rmSync(join(engineDataDir, ".."), { recursive: true, force: true });
});
