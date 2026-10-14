// The fixture patches (src/fixtures/patches.ts) are what git prints for
// the repositories in lib/fixtureRepos.ts, so none drifts into a patch
// git would never write: a hunk whose counts disagree with its lines, a
// short blob id where the host prints a full one. Run with
// UPDATE_FIXTURES=1 to write the module again after changing them.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import * as patches from "../src/fixtures/patches.ts";
import {
  buildChangesPatches,
  buildCommitPatch,
  renderPatchesModule,
} from "./lib/fixtureRepos.ts";

it("holds what git prints for the fixture repositories", () => {
  if (process.env.UPDATE_FIXTURES) {
    writeFileSync(
      join(import.meta.dirname, "../src/fixtures/patches.ts"),
      renderPatchesModule(),
    );
    return;
  }
  const commit = buildCommitPatch();
  assert.equal(patches.COMMIT_PATCH, commit.patch);
  assert.deepEqual(patches.COMMIT_ICON_SIDES, commit.icon);
  assert.deepEqual(patches.CHANGE_PATCHES, buildChangesPatches());
});
