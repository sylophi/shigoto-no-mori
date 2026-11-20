// A file left out of a commit and later turned conflicted comes back
// ticked once resolved: the merge commit takes the resolution, and
// "Discard unticked" doesn't count it.
import { describe, expect, it } from "vitest";
import {
  ALL_TICKED,
  prunedPicks,
  setFilesTicked,
  tickedOf,
} from "@shigomori/ui/views/diff/changesPicks.ts";
import { changeKey, type ChangedFile } from "@shigomori/contracts/schemas";

const plain: ChangedFile = { path: "a.txt", kind: "modified", staged: "none" };
const conflicted: ChangedFile = { ...plain, conflicted: true };

describe("changes picks", () => {
  it("drops a left-out pick when its file turns conflicted", () => {
    const leftOut = setFilesTicked(ALL_TICKED, [changeKey(plain)], false);
    expect(tickedOf(leftOut, plain)).toBe("none");
    const pruned = prunedPicks(leftOut, [conflicted]);
    expect(tickedOf(pruned, plain)).toBe("all");
  });
});
