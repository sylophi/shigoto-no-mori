// The proofs in test/ (test/README.md). They spawn real git, the real
// sm and file-sync binaries, sockets and workerd, and some bind fixed
// ports, so they run one file at a time, each in a process of its own.
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { isolateGit } from "../gitIsolation";
import { ownTestTemp } from "../testTemp.mts";
import { dedupe } from "./vite.dedupe";

// Before any proof's process forks, so none inherits a way into this
// repository (../gitIsolation.ts), and every one leaves its temp files
// in the run's folder (../testTemp.mts).
isolateGit();
ownTestTemp("app");

const dir = (name: string) => join(import.meta.dirname, name);

export default defineConfig({
  // The tsconfig path aliases. Vite resolves extensionless specifiers
  // and bare JSON imports on its own.
  resolve: {
    dedupe,
    alias: {
      "@shared": dir("shared"),
      "@host": dir("host"),
      "@": dir("renderer"),
    },
  },
  test: {
    include: ["test/*.mts"],
    exclude: ["test/run.mts"],
    setupFiles: ["../testProcesses.setup.mts", "test/lib/hostSetup.mts"],
    pool: "forks",
    fileParallelism: false,
    // A check can build sm from a cold Go cache, or drive a whole
    // mirror cycle.
    testTimeout: 5 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
