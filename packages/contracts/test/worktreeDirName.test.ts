// The folder a branch's worktree is made in, the same on every OS.
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  isValidWorktreeDirName,
  sanitizeBranchForPath,
} from "../src/predicates/worktreeDirName.ts";

it("keeps the folder a branch already had", () => {
  for (const [branch, folder] of [
    ["feature/login", "feature-login"],
    ["fix:JIRA-123", "fix-JIRA-123"],
    ["release/v1.0.", "release-v1.0"],
    ["日本語/ブランチ", "日本語-ブランチ"],
    ["feature/con", "feature-con"],
    ["console", "console"],
    ["com10", "com10"],
  ] as const) {
    assert.equal(sanitizeBranchForPath(branch), folder);
  }
});

it("spells what Windows can't hold in a name as a separator", () => {
  assert.equal(sanitizeBranchForPath("feature/<new>"), "feature--new");
  assert.equal(sanitizeBranchForPath('fix/"quoted"|x'), "fix--quoted--x");
  assert.equal(sanitizeBranchForPath("a?b*c\\d"), "a-b-c-d");
});

it("picks a name for a branch Windows reads as a device", () => {
  for (const branch of ["aux", "NUL.txt", "con .tar.gz", "com1", "lpt¹"]) {
    assert.equal(sanitizeBranchForPath(branch), "");
    assert.ok(!isValidWorktreeDirName(branch));
  }
});
