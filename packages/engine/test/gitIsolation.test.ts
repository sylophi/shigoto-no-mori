// No test's git can reach this repository (../../../gitIsolation.ts,
// applied by ../vitest.config.ts).
import { it } from "vitest";
import {
  assertGitIsolated,
  assertRepositoryHidden,
} from "../../../gitIsolation.ts";

it("no test's git can reach this repository", () => {
  assertGitIsolated(import.meta.dirname);
});

it("the sandboxes' own scrub keeps the repository out of reach", async () => {
  await import("./lib/gitRepos.ts");
  await import("./lib/sandbox.ts");
  assertRepositoryHidden(import.meta.dirname);
});
