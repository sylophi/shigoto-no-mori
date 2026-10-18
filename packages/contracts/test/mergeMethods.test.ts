// How a pull request merges (src/mergeMethods.ts), which the engine's
// landing and the merge box both go by: the methods a repo allows, an
// unread config allowing every one and no auto-merge, the method a
// merge takes with none asked for, and the verdicts that arm
// auto-merge.
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  autoMergeArms,
  mergeSettingsOf,
  pickMergeMethod,
} from "../src/mergeMethods.ts";

it("a repo's methods in their order, and every one when its config is unread", () => {
  assert.deepEqual(
    mergeSettingsOf({
      merge: false,
      squash: true,
      rebase: true,
      autoMerge: true,
    }),
    { allowed: ["squash", "rebase"], autoMerge: true },
  );
  assert.deepEqual(mergeSettingsOf(null), {
    allowed: ["merge", "squash", "rebase"],
    autoMerge: false,
  });
});

it("the last pick while allowed, else the first, else none", () => {
  assert.equal(pickMergeMethod(["merge", "rebase"], "rebase"), "rebase");
  assert.equal(pickMergeMethod(["merge", "rebase"], "squash"), "merge");
  assert.equal(pickMergeMethod(["squash"], undefined), "squash");
  assert.equal(pickMergeMethod([], "merge"), null);
});

it("auto-merge arms on a verdict waiting on rules or a catch-up", () => {
  assert.ok(autoMergeArms("BLOCKED"));
  assert.ok(autoMergeArms("BEHIND"));
  assert.ok(!autoMergeArms("CLEAN"));
  assert.ok(!autoMergeArms(undefined));
});
