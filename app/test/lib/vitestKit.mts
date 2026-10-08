// The per-test teardown, apart from checkKit.mts because it needs
// vitest at load, and plain scripts (test/bench) import the kit:
// loading vitest outside its runner changes how a script shuts down.
import { onTestFinished } from "vitest";
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
