// The tests spawn real processes, so each file runs in a process of
// its own, one at a time (EFFECT.md section 9).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
  },
});
