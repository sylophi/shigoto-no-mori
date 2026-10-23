// What counts as a managed worktree, which nuke force-removes, and what
// as external, the user's own, which it leaves.
import assert from "node:assert/strict";
import { it } from "vitest";
import { isManagedPath } from "../src/worktreeLayout.ts";

it("holds a worktree managed by its parent, not a prefix", () => {
  const bases = ["/", "/Users/me/.sm/wt/repo/"];
  assert.ok(isManagedPath("/Users/me/.sm/wt/repo/otter/", bases));
  assert.ok(!isManagedPath("/Users/me/.sm/wt/repo/otter/deep", bases));
  assert.ok(!isManagedPath("relative", bases));
});
