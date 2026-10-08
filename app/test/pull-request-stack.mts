// Durable proof for stack detection (shared/pullRequestStack.ts), the
// pure read the sidebar pill, the worktree page and the merge button
// all share. A chain of PRs based on each other's heads is a stack,
// bottom first, and a merged bottom stays in it. The trunk is never a
// member (a "main -> production" PR must not sit under every stack).
// A fork ends the walk up, and stale rows that loop still end the
// walk. The merge set skips landed PRs and refuses a broken stack.
// Run: pnpm test pull-request-stack.
import assert from "node:assert/strict";
import {
  pullRequestStackFor,
  placeByStack,
  pullRequestStackPosition,
  stackCleanupFor,
  stackCleanupForWorktree,
  stackMergeSet,
  trunkOf,
} from "@shared/pullRequestStack";
import type { PullRequest } from "@shigomori/contracts/schemas";
import { it } from "vitest";

let n = 100;
const pr = (
  baseRefName: string,
  state: PullRequest["state"] = "OPEN",
  isDraft = false,
): PullRequest => ({
  number: n++,
  url: `https://github.com/o/r/pull/${n}`,
  title: `PR ${n}`,
  state,
  isDraft,
  baseRefName,
});

const wt = <T extends object>(branch: string, extra: T) => ({
  branch,
  ...extra,
});

const prs = {
  "layer-a": pr("main", "MERGED"),
  "layer-b": pr("layer-a"),
  "layer-c": pr("layer-b", "OPEN", true),
  hotfix: pr("main"),
  main: pr("production"),
};

it("a chain is one stack, bottom first, whatever the state", () => {
  const stack = pullRequestStackFor(prs, "layer-b", "main");
  assert.ok(stack);
  assert.deepEqual(
    stack.entries.map((e) => e.branch),
    ["layer-a", "layer-b", "layer-c"],
  );
  assert.equal(stack.base, "main");
  assert.equal(stack.index, 1);
  assert.equal(pullRequestStackFor(prs, "layer-c", "main")?.index, 2);
  assert.deepEqual(pullRequestStackPosition(prs, "layer-a", "main"), {
    index: 0,
    size: 3,
  });
});

it("a PR on its own, or the trunk's own PR, is no stack", () => {
  assert.equal(pullRequestStackFor(prs, "hotfix", "main"), null);
  assert.equal(pullRequestStackFor(prs, "main", "main"), null);
  assert.equal(pullRequestStackFor(prs, "nope", "main"), null);
  assert.equal(pullRequestStackPosition(undefined, "hotfix", "main"), null);
});

it("without the trunk, the promotion PR would be the bottom", () => {
  const stack = pullRequestStackFor(prs, "hotfix");
  assert.ok(stack);
  assert.deepEqual(
    stack.entries.map((e) => e.branch),
    ["main", "hotfix"],
  );
  assert.equal(stack.base, "production");
});

it("a fork ends the walk up, and a loop in stale rows still ends", () => {
  const forked = { ...prs, "layer-b2": pr("layer-a") };
  // Walking up from the fork point stops there, and a chain of one
  // is no stack: the bottom's pill shows nothing until the chain
  // above it is unambiguous.
  assert.equal(pullRequestStackFor(forked, "layer-a", "main"), null);
  const fromLeaf = pullRequestStackFor(forked, "layer-b2", "main");
  assert.ok(fromLeaf);
  assert.deepEqual(
    fromLeaf.entries.map((e) => e.branch),
    ["layer-a", "layer-b2"],
  );
  const loop = { a: pr("b"), b: pr("a") };
  const stack = pullRequestStackFor(loop, "a", "main");
  assert.ok(stack);
  assert.deepEqual(
    stack.entries.map((e) => e.branch),
    ["b", "a"],
  );
});

it("the merge set is the open PRs up to the asked one, none past a closed one", () => {
  const stack = pullRequestStackFor(prs, "layer-c", "main");
  assert.ok(stack);
  assert.deepEqual(
    stackMergeSet(stack, 2)?.map((e) => e.branch),
    ["layer-b", "layer-c"],
    "the merged bottom drops out",
  );
  assert.deepEqual(
    stackMergeSet(stack, 1)?.map((e) => e.branch),
    ["layer-b"],
  );
  const broken = { ...prs, "layer-b": pr("layer-a", "CLOSED") };
  const brokenStack = pullRequestStackFor(broken, "layer-c", "main");
  assert.ok(brokenStack);
  assert.equal(stackMergeSet(brokenStack, 2), null);
  assert.deepEqual(stackMergeSet(brokenStack, 0), []);
});
it("the trunk is the host's primary branch, else the primary checkout's", () => {
  assert.equal(trunkOf(undefined), undefined);
  assert.equal(
    trunkOf([wt("layer-l", { isPrimary: true, primaryBranch: "main" })]),
    "main",
    "the host's answer wins over whatever the primary checkout has out",
  );
  assert.equal(
    trunkOf([wt("main", { isPrimary: true }), wt("x", { isPrimary: false })]),
    "main",
    "an older host's listing falls back to the primary checkout's branch",
  );
});

it("rows of a stack gather where its first row was, top first, peers' copies beside", () => {
  const rows = [
    "main",
    "hotfix",
    "layer-a",
    "other",
    "layer-c",
    "layer-b",
    "layer-b",
  ];
  const placed = placeByStack(rows, (r) => r, prs, "main");
  assert.deepEqual(
    placed.map((p) => p.item),
    ["main", "hotfix", "layer-c", "layer-b", "layer-b", "layer-a", "other"],
  );
  assert.deepEqual(
    placed.map(
      (p) => p.position && `${p.position.index + 1}/${p.position.size}`,
    ),
    [null, null, "3/3", "2/3", "2/3", "1/3", null],
  );
  assert.deepEqual(
    placed.map((p) => p.rail ?? null),
    [
      null,
      null,
      { last: false, whole: true },
      { last: false, whole: true },
      { last: false, whole: true },
      { last: true, whole: true },
      null,
    ],
    "every gathered member is a stop on the rail, the bottom one last",
  );
  assert.deepEqual(
    placeByStack(["layer-c", "layer-a"], (r) => r, prs, "main").map(
      (p) => p.rail,
    ),
    [
      { last: false, whole: false },
      { last: true, whole: false },
    ],
    "a rail that skips a layer is not whole",
  );
  assert.deepEqual(
    placeByStack(rows, (r) => r, undefined, "main").map((p) => p.item),
    rows,
  );
  // A fork point has no stack of its own, and must not be picked
  // up again by the group of a layer above it.
  const forked = { ...prs, "layer-b2": pr("layer-a") };
  assert.deepEqual(
    placeByStack(
      ["layer-a", "layer-b", "layer-b2"],
      (r) => r,
      forked,
      "main",
    ).map((p) => p.item),
    ["layer-a", "layer-b", "layer-b2"],
  );
  // One layer showing of a stack gets no rail, even with a peer's
  // copy of it beside the local row.
  assert.deepEqual(
    placeByStack(["layer-b", "layer-b"], (r) => r, prs, "main").map(
      (p) => p.rail ?? null,
    ),
    [null, null],
  );
  assert.deepEqual(
    placeByStack(["layer-b", "other"], (r) => r, prs, "main").map(
      (p) => p.rail ?? null,
    ),
    [null, null],
  );
});

it("a stack cleanup takes the merged layers' worktrees, run from the highest", () => {
  const merged = {
    ...prs,
    "layer-b": pr("layer-a", "MERGED"),
  };
  const rows = [
    wt("main", { id: "p", isPrimary: true }),
    wt("layer-a", { id: "a", isPrimary: false }),
    wt("layer-b", { id: "b", isPrimary: false }),
    wt("layer-c", { id: "c", isPrimary: false }),
  ];
  const stack = pullRequestStackFor(merged, "layer-c", "main");
  assert.ok(stack);
  const cleanup = stackCleanupFor(stack, rows);
  assert.ok(cleanup);
  assert.deepEqual(
    cleanup.worktrees.map((w) => w.id),
    ["a", "b"],
    "the open top stays",
  );
  assert.equal(cleanup.target.id, "b");
  // The primary checkout on a landed layer is never among them,
  // and a stack with no landed worktree offers nothing.
  const onPrimary = [wt("layer-a", { id: "p", isPrimary: true })];
  assert.equal(stackCleanupFor(stack, onPrimary), null);
  const open = pullRequestStackFor(prs, "layer-c", "main");
  assert.ok(open);
  assert.equal(
    stackCleanupFor(open, rows)?.worktrees.length,
    1,
    "only the merged bottom",
  );
  // By worktree id, off a device's own map and rows, any layer's
  // worktree names the same cleanup. An unknown id names none.
  const byId = stackCleanupForWorktree(merged, rows, "a");
  assert.ok(byId);
  assert.deepEqual(
    byId.worktrees.map((w) => w.id),
    ["a", "b"],
  );
  assert.equal(byId.target.id, "b");
  assert.equal(stackCleanupForWorktree(merged, rows, "nope"), null);
});
