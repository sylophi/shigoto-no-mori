// Tidy's acknowledgement of lost work (src/views/tidy/tidyModel.ts),
// which the confirm step and the removal both read: it covers the risky
// worktrees it was given for, and no other.
import assert from "node:assert/strict";
import { it } from "vitest";
import { worktree } from "../src/fixtures/fixtures.ts";
import {
  acknowledgementOf,
  acknowledges,
  forcedRemoval,
  summarize,
  type TidyEntry,
} from "../src/views/tidy/tidyModel.ts";

// A row, dirty (git refuses it unforced), unpushed, or merged.
const entry = (
  id: string,
  kind: "dirty" | "unpushed" | "merged",
): TidyEntry => ({
  worktree: worktree({
    id,
    projectId: "P",
    name: id,
    branch: id,
    path: `/p/${id}`,
  }),
  project: { id: "P", name: "proj", path: "/p" },
  verdict: {
    kind,
    safe: kind === "merged",
    needsForce: kind === "dirty",
    reason: "",
  },
  disk: undefined,
  diskFailed: false,
  ageAt: null,
  lastActivityAt: null,
});

it("a second selected worktree turning dirty clears the tick, and is forced only once acknowledged", () => {
  const selected = new Set(["a", "b"]);
  const before = summarize(
    [entry("a", "dirty"), entry("b", "merged")],
    selected,
  );
  const acknowledged = acknowledgementOf(before.risky);
  assert.equal(acknowledges(acknowledged, before.risky), true);

  // b goes dirty while the dialog is open, under the same tick.
  const after = summarize([entry("a", "dirty"), entry("b", "dirty")], selected);
  assert.equal(acknowledges(acknowledged, after.risky), false);
  const [a, b] = after.selected;
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(forcedRemoval(a, acknowledged), true);
  assert.equal(forcedRemoval(b, acknowledged), false);

  const again = acknowledgementOf(after.risky);
  assert.equal(acknowledges(again, after.risky), true);
  assert.equal(forcedRemoval(b, again), true);
});

it("a worktree acknowledged for its unpushed commits that gets uncommitted changes clears the tick, and isn't forced", () => {
  const selected = new Set(["a"]);
  const before = summarize([entry("a", "unpushed")], selected);
  const acknowledged = acknowledgementOf(before.risky);
  assert.equal(acknowledges(acknowledged, before.risky), true);
  const after = summarize([entry("a", "dirty")], selected);
  assert.equal(acknowledges(acknowledged, after.risky), false);
  const [a] = after.selected;
  assert.ok(a !== undefined);
  assert.equal(forcedRemoval(a, acknowledged), false);
});
