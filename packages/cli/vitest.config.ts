// The tests build the terminal binary and run it, so each file runs
// alone and a test gets longer than vitest's default.
import { defineConfig } from "vitest/config";
import { isolateGit } from "../../test/gitIsolation";
import { ownTestTemp } from "../../test/testTemp.mts";

// Before any test's process forks, so none inherits a way into this
// repository (../../test/gitIsolation.ts), and every one leaves its temp
// files in the run's folder (../../test/testTemp.mts).
isolateGit();
ownTestTemp("cli");

export default defineConfig({
  test: {
    setupFiles: ["../../test/testProcesses.setup.mts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
