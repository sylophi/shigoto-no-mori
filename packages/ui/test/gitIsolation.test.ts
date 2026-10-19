// No test's git can reach this repository (../../../gitIsolation.ts,
// applied by ../vitest.config.ts), the fixture repositories' own
// included.
import { it } from "vitest";
import {
  assertGitIsolated,
  assertRepositoryHidden,
} from "../../../gitIsolation.ts";

it("no test's git can reach this repository", () => {
  assertGitIsolated(import.meta.dirname);
});

it("the fixture repositories' git keeps the repository out of reach", async () => {
  await import("./lib/fixtureRepos.ts");
  assertRepositoryHidden(import.meta.dirname);
});
