// The proofs in test/ (test/README.md). They spawn real git, the real
// sm and file-sync binaries, sockets and workerd, and some bind fixed
// ports, so they run one file at a time, each in a process of its own.
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const dir = (name: string) => join(import.meta.dirname, name);

export default defineConfig({
  // The tsconfig path aliases. Vite resolves extensionless specifiers
  // and bare JSON imports on its own.
  resolve: {
    alias: {
      "@shared": dir("shared"),
      "@host": dir("host"),
      "@": dir("renderer"),
    },
  },
  test: {
    include: ["test/*.mts"],
    exclude: ["test/run.mts"],
    pool: "forks",
    fileParallelism: false,
    // A check can build sm from a cold Go cache, or drive a whole
    // mirror cycle.
    testTimeout: 5 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
