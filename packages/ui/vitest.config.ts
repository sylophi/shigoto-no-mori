// The proofs read sources (the boundary) and render the scenes in Node,
// where there is no window.
import { defineConfig } from "vitest/config";
import { isolateGit } from "../../gitIsolation";

// The fixture patches' repositories run git (test/lib/fixtureRepos.ts).
isolateGit();

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // Every case renders synchronously and waits on nothing, so a slow
    // machine only makes it slower: no per-case deadline to miss.
    testTimeout: 0,
  },
});
