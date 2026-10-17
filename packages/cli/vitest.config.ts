// The tests build the terminal binary and run it, so each file runs
// alone and a test gets longer than vitest's default.
import { defineConfig } from "vitest/config";
import { isolateGit } from "../../gitIsolation";
import { ownTestTemp } from "../../testTemp.mts";

// Before any test's process forks, so none inherits a way into this
// repository (../../gitIsolation.ts), and every one leaves its temp
// files in the run's folder (../../testTemp.mts).
isolateGit();
ownTestTemp("cli");

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
