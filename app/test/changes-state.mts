// Durable proof for what the changes page says about the working tree
// (renderer/lib/changesState.ts). In the lab, a worktree whose index
// git could no longer read kept its last read on the page, "No changes",
// while the tree had an edit, and an edit made with the window focused
// left the page's list behind the row's count. Asserts:
//   - the row's count stands in until the page's read arrives;
//   - a read that fails, first or after one that answered, is the
//     failed state with no count, never the last answer standing;
//   - the key the page reads again on moves with the row's count and
//     with its newest change.
//
// Run: pnpm test changes-state.
import assert from "node:assert/strict";
import { it } from "vitest";
import { changesState, treeMovedKey } from "@/lib/changesState";

it("the row's count stands in, and a failed read never reads as the last answer", () => {
  assert.deepEqual(changesState(undefined, null, 3), {
    failed: false,
    loading: true,
    changedCount: 3,
    list: [],
  });
  assert.deepEqual(changesState(["a.txt"], null, 3), {
    failed: false,
    loading: false,
    changedCount: 1,
    list: ["a.txt"],
  });
  const unreadable = new Error(
    "fatal: .git/index: index file smaller than expected",
  );
  // A read that answered "nothing", then failed: not "No changes".
  assert.deepEqual(changesState([], unreadable, 0), {
    failed: true,
    loading: false,
    changedCount: null,
    list: [],
  });
  assert.deepEqual(changesState(undefined, unreadable, 2), {
    failed: true,
    loading: false,
    changedCount: null,
    list: [],
  });
});

it("the page reads again when the row's count or newest change moves", () => {
  const before = treeMovedKey({ changedCount: 1, lastChangeAt: 100 });
  assert.notEqual(before, treeMovedKey({ changedCount: 2, lastChangeAt: 100 }));
  assert.notEqual(before, treeMovedKey({ changedCount: 1, lastChangeAt: 101 }));
  assert.equal(before, treeMovedKey({ changedCount: 1, lastChangeAt: 100 }));
  assert.notEqual(treeMovedKey({ changedCount: 0 }), before);
});
