// The tests build the terminal binary and run it beside the Go sm, so
// each file runs alone and a test gets longer than vitest's default.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
