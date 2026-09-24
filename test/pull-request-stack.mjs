// Durable proof for stack detection (shared/pullRequestStack.ts), the
// pure read the sidebar pill, the worktree page and the merge button
// all share: a chain of PRs based on each other's heads is a stack,
// bottom first; a merged bottom stays in it; the trunk is never a
// member (a "main -> production" PR must not sit under every stack);
// a fork ends the walk up; stale rows that loop still end the walk;
// and the merge set skips landed PRs and refuses a broken stack.
// Runs under test/lib/register-ts-alias.mjs. See package.json
// pnpm test pull-request-stack.
import assert from "node:assert/strict";
import {
  pullRequestStackFor,
  pullRequestStackPosition,
  stackMergeSet,
  trunkOf,
} from "@shared/pullRequestStack";
import { makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("pull-request-stack proof");
console.log("pull-request-stack proof\n");

let n = 100;
const pr = (baseRefName, state = "OPEN", isDraft = false) => ({
  number: n++,
  url: `https://github.com/o/r/pull/${n}`,
  title: `PR ${n}`,
  state,
  isDraft,
  baseRefName,
});

const wt = (branch, extra = {}) => ({ branch, ...extra });

const prs = {
  "layer-a": pr("main", "MERGED"),
  "layer-b": pr("layer-a"),
  "layer-c": pr("layer-b", "OPEN", true),
  hotfix: pr("main"),
  main: pr("production"),
};

try {
  await proof.check(
    "a chain is one stack, bottom first, whatever the state",
    () => {
      const stack = pullRequestStackFor(prs, "layer-b", "main");
      assert.ok(stack);
      assert.deepEqual(
        stack.entries.map((e) => e.branch),
        ["layer-a", "layer-b", "layer-c"],
      );
      assert.equal(stack.base, "main");
      assert.equal(stack.index, 1);
      assert.equal(pullRequestStackFor(prs, "layer-c", "main").index, 2);
      assert.deepEqual(pullRequestStackPosition(prs, "layer-a", "main"), {
        index: 0,
        size: 3,
      });
    },
  );

  await proof.check(
    "a PR on its own, or the trunk's own PR, is no stack",
    () => {
      assert.equal(pullRequestStackFor(prs, "hotfix", "main"), null);
      assert.equal(pullRequestStackFor(prs, "main", "main"), null);
      assert.equal(pullRequestStackFor(prs, "nope", "main"), null);
      assert.equal(pullRequestStackPosition(undefined, "hotfix", "main"), null);
    },
  );

  await proof.check(
    "without the trunk, the promotion PR would be the bottom",
    () => {
      const stack = pullRequestStackFor(prs, "hotfix");
      assert.deepEqual(
        stack.entries.map((e) => e.branch),
        ["main", "hotfix"],
      );
      assert.equal(stack.base, "production");
    },
  );

  await proof.check(
    "a fork ends the walk up; a loop in stale rows still ends",
    () => {
      const forked = { ...prs, "layer-b2": pr("layer-a") };
      // Walking up from the fork point stops there, and a chain of one
      // is no stack: the bottom's pill shows nothing until the chain
      // above it is unambiguous.
      assert.equal(pullRequestStackFor(forked, "layer-a", "main"), null);
      const fromLeaf = pullRequestStackFor(forked, "layer-b2", "main");
      assert.deepEqual(
        fromLeaf.entries.map((e) => e.branch),
        ["layer-a", "layer-b2"],
      );
      const loop = { a: pr("b"), b: pr("a") };
      const stack = pullRequestStackFor(loop, "a", "main");
      assert.deepEqual(
        stack.entries.map((e) => e.branch),
        ["b", "a"],
      );
    },
  );

  await proof.check(
    "the merge set is the open PRs up to the asked one, none past a closed one",
    () => {
      const stack = pullRequestStackFor(prs, "layer-c", "main");
      assert.deepEqual(
        stackMergeSet(stack, 2).map((e) => e.branch),
        ["layer-b", "layer-c"],
        "the merged bottom drops out",
      );
      assert.deepEqual(
        stackMergeSet(stack, 1).map((e) => e.branch),
        ["layer-b"],
      );
      const broken = { ...prs, "layer-b": pr("layer-a", "CLOSED") };
      const brokenStack = pullRequestStackFor(broken, "layer-c", "main");
      assert.equal(stackMergeSet(brokenStack, 2), null);
      assert.deepEqual(stackMergeSet(brokenStack, 0), []);
    },
  );
  await proof.check(
    "the trunk comes off the listing's primary ref, whatever the primary checkout has out",
    () => {
      assert.equal(trunkOf(undefined), undefined);
      assert.equal(trunkOf([wt("main", { isPrimary: true })]), "main");
      assert.equal(
        trunkOf([
          wt("main", { isPrimary: true }),
          wt("x", { primaryRef: "origin/main" }),
        ]),
        "main",
      );
      assert.equal(
        trunkOf([
          wt("layer-l", { isPrimary: true, primaryRef: "origin/main" }),
        ]),
        "main",
        "a primary checkout on a feature branch is not the trunk",
      );
      assert.equal(
        trunkOf([
          wt("release/2.0", { isPrimary: true }),
          wt("x", { primaryRef: "release/2.0" }),
        ]),
        "release/2.0",
      );
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
}
