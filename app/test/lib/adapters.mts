// Every proof's file runs with the Promise adapters of the converted
// subsystems up, the way the app's graph (main/hostLayer.ts) brings
// them up, so host code a proof reaches answers instead of waiting
// for a graph that never comes (EFFECT.md, runtime boundaries).
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, beforeAll } from "vitest";
import * as FileSync from "../../host/fileSync/FileSync.ts";
import * as GithubCli from "../../host/lib/githubCli/GithubCli.ts";
import * as Ports from "../../host/lib/ports.ts";
import * as ScriptRuns from "../../host/lib/scripts/pty.ts";
import * as Terrier from "../../host/lib/terrier.ts";
import * as Processes from "../../host/lib/util/processes.ts";
import * as Villagers from "../../host/lib/villagers.ts";

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
    Layer.provideMerge(Terrier.adapter),
    Layer.provideMerge(Terrier.layer),
    Layer.provideMerge(Ports.adapter),
    Layer.provideMerge(Ports.layer),
    Layer.provideMerge(Villagers.adapter),
    Layer.provideMerge(Villagers.deviceLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

beforeAll(() => runtime.context());
afterAll(() => runtime.dispose());
