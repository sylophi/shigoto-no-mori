// The tests spawn real processes, so each file runs in a process of
// its own, one at a time (EFFECT.md section 9), and a test that builds
// repos and runs git against them gets longer than vitest's
// default to finish.
import { defineConfig } from "vitest/config";
import { isolateGit } from "../../gitIsolation";
import { ownTestTemp } from "../../testTemp.mts";

// Before any test's process forks, so none inherits a way into this
// repository (../../gitIsolation.ts), and every one leaves its temp
// files in the run's folder (../../testTemp.mts).
isolateGit();
ownTestTemp("engine");

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
