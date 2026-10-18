// Proof for the branch in the way of one a pull lands on
// (shared/pullCollision.ts, branchInTheWay), which the host's landing
// and the pull review both refuse: git keeps refs in a directory tree,
// so a branch can sit neither under an existing one nor above it.
//
// Run: pnpm test pull-collision.
import assert from "node:assert/strict";
import { it } from "vitest";
import { branchInTheWay } from "@shared/pullCollision";

it("a branch above or under the landing one is in its way, a lookalike name is not", () => {
  assert.equal(branchInTheWay("mirror/main", ["main", "mirror"]), "mirror");
  assert.equal(branchInTheWay("mirror", ["mirror/main"]), "mirror/main");
  assert.equal(
    branchInTheWay("mirror/main", ["mirrorx", "mirror-main"]),
    undefined,
  );
  assert.equal(branchInTheWay("mirrorx", ["mirror/main"]), undefined);
  assert.equal(branchInTheWay("feat", []), undefined);
});
