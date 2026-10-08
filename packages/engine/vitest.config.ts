import { defineConfig } from "vitest/config";

// The proofs spawn real git and the real sm, so each file runs alone in
// its own fork.
export default defineConfig({
  test: { pool: "forks", fileParallelism: false },
});
