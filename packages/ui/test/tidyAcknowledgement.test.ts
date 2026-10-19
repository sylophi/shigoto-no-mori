// Tidy's acknowledgement of lost work (src/views/tidy/tidyModel.ts),
// which the confirm step and the removal both read: it covers the risky
// worktrees it was given for, and no other.
import assert from "node:assert/strict";
import { it } from "vitest";
import { worktree } from "../src/fixtures/fixtures.ts";
import {
  acknowledges,
  forcedRemoval,
  summarize,
  type TidyEntry,
} from "../src/views/tidy/tidyModel.ts";

// A row, dirty (git refuses it unforced) or merged.
const entry = (id: string, dirty: boolean): TidyEntry => ({
  worktree: worktree({
    id,
    projectId: "P",
    name: id,
    branch: id,
    path: `/p/${id}`,
  }),
  project: { id: "P", name: "proj", path: "/p" },
  verdict: {
    kind: dirty ? "dirty" : "merged",
    safe: !dirty,
    needsForce: dirty,
    reason: "",
  },
  disk: undefined,
  diskFailed: false,
  ageAt: null,
  lastActivityAt: null,
});

it("a second selected worktree turning dirty clears the tick, and is forced only once acknowledged", () => {
  const selected = new Set(["a", "b"]);
  const before = summarize([entry("a", true), entry("b", false)], selected);
  const acknowledged = new Set(before.risky.map((row) => row.worktree.id));
  assert.equal(acknowledges(acknowledged, before.risky), true);

  // b goes dirty while the dialog is open, under the same tick.
  const after = summarize([entry("a", true), entry("b", true)], selected);
  assert.equal(acknowledges(acknowledged, after.risky), false);
  const [a, b] = after.selected;
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(forcedRemoval(a, acknowledged), true);
  assert.equal(forcedRemoval(b, acknowledged), false);

  const again = new Set(after.risky.map((row) => row.worktree.id));
  assert.equal(acknowledges(again, after.risky), true);
  assert.equal(forcedRemoval(b, again), true);
});
