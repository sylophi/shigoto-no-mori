// The per-test teardown, apart from checkKit.mts because it needs
// vitest at load, and plain scripts (test/bench) import the kit:
// loading vitest outside its runner changes how a script shuts down.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, beforeAll, onTestFinished } from "vitest";
import * as Processes from "../../host/lib/util/processes.ts";
import type { Track } from "./checkKit.mts";

// Registers a teardown for the running test: teardowns run once it
// ends, pass or fail, in reverse order, and a failing one is swallowed
// like makeTracker's, so a cleanup failure never masks the outcome.
export const trackTest: Track = (fn) => {
  onTestFinished(async () => {
    try {
      await fn();
    } catch {
      // One failing teardown must not strand the rest.
    }
  });
  return fn;
};

// Brings a layer up for the file's tests and down after them, the way
// the app's graph does (main/hostLayer.ts), for host code that reaches
// a converted subsystem through its Promise adapter.
export function withLayer<R>(layer: Layer.Layer<R>): void {
  const runtime = ManagedRuntime.make(layer);
  beforeAll(() => runtime.context());
  afterAll(() => runtime.dispose());
}

// The host's child processes (host/lib/util/processes.ts).
export const processesLayer = Processes.adapter.pipe(
  Layer.provideMerge(NodeServices.layer),
);
