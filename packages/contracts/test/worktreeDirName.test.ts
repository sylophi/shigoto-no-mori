// The folder a branch's worktree is made in, the same on every OS.
import assert from "node:assert/strict";
import { it } from "vitest";
import { sanitizeBranchForPath } from "../src/predicates/worktreeDirName.ts";

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
