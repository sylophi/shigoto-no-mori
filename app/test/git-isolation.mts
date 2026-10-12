// Durable proof that no proof's git can reach this repository: the
// runner and the config isolate every proof's process
// (../../gitIsolation.ts), so no GIT_* variable from outside is left
// and a git started inside the repository finds none, before a proof's
// own scrub (lib/checkKit.mts) and after it. Under the
// pre-commit hook this is what fails if the hook's GIT_DIR got through.
//
// Run: pnpm test git-isolation.
//
// covers: gitIsolation.ts
// covers: app/vitest.config.ts
import { it } from "vitest";
import {
  assertGitIsolated,
  assertRepositoryHidden,
} from "../../gitIsolation.ts";
import { appRoot, scrubProcessGitEnv } from "./lib/checkKit.mts";

it("no proof's git can reach this repository", () => {
  assertGitIsolated(appRoot);
});

it("a proof's own scrub keeps the repository out of reach", () => {
  scrubProcessGitEnv();
  assertRepositoryHidden(appRoot);
});
