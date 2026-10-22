// Proof for what the host's landing and the pull review both refuse
// (shared/pullCollision.ts): the branch in the way of one a pull lands
// on (branchInTheWay), since git keeps refs in a directory tree, so a
// branch can sit neither under an existing one nor above it; and the
// branch already checked out here, whose worktree is named, a shelved
// one saying so.
//
// Run: pnpm test pull-collision.
import assert from "node:assert/strict";
import { it } from "vitest";
import { branchInTheWay, pullBranchCollision } from "@shared/pullCollision";

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

it("a branch checked out in a shelved worktree says it's shelved", () => {
  assert.equal(
    pullBranchCollision("rw-send", { name: "rw-send", shelved: true }),
    "rw-send is already checked out on this device in rw-send, which is shelved. Delete that worktree first, or unshelve it and pull normally.",
  );
  assert.equal(
    pullBranchCollision(
      "feat",
      { name: "feat-wt", shelved: false },
      "on Thinkpad",
    ),
    "feat is already checked out on Thinkpad in feat-wt. Delete that worktree first, or open it and pull normally.",
  );
});
