// The page walks (../walks.md): each file starts the packaged lab build
// on real git and drives its window. One app at a time, since a build's
// single-instance lock is machine-wide.
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { isolateGit } from "../../../gitIsolation";
import { ownTestTemp } from "../../../testTemp.mts";

isolateGit();
ownTestTemp("walks");

export default defineConfig({
  root: join(import.meta.dirname, "..", ".."),
  test: {
    include: ["lab/walks/*.walk.mts"],
    globalSetup: ["lab/walks/lib/teardown.mts"],
    pool: "forks",
    fileParallelism: false,
    // A runner under load takes seconds to land what a click asked
    // for, past expect.poll's own second.
    expect: { poll: { timeout: 10_000 } },
    testTimeout: 3 * 60_000,
    hookTimeout: 2 * 60_000,
  },
});
