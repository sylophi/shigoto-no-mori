// Every proof's file runs with the Promise adapters of the converted
// subsystems up, the way the app's graph (main/hostLayer.ts) brings
// them up, so host code a proof reaches answers instead of waiting
// for a graph that never comes (EFFECT.md, runtime boundaries).
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, beforeAll } from "vitest";
import * as Processes from "../../host/lib/util/processes.ts";

const runtime = ManagedRuntime.make(
  Processes.adapter.pipe(Layer.provideMerge(NodeServices.layer)),
);

beforeAll(() => runtime.context());
afterAll(() => runtime.dispose());
