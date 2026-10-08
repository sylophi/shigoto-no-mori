// The tests spawn real processes, so each file runs in a process of
// its own, one at a time (EFFECT.md section 9), and a test that builds
// repos and runs the Go sm against them gets longer than vitest's
// default to finish.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
