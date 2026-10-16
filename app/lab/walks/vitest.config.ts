// The page walks (../walks.md): each file starts the packaged lab build
// on real git and drives its window. One app at a time, since a build's
// single-instance lock is machine-wide.
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { isolateGit } from "../../../gitIsolation";

isolateGit();

export default defineConfig({
  root: join(import.meta.dirname, "..", ".."),
  test: {
    include: ["lab/walks/*.walk.mts"],
    globalSetup: ["lab/walks/lib/teardown.mts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 3 * 60_000,
    hookTimeout: 2 * 60_000,
  },
});
