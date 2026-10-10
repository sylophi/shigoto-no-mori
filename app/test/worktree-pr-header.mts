// Durable proof for the two reads behind the worktree page's PR
// header: which PR, if any, names the page (titledByPullRequest,
// lib/worktreeTitle.ts), and the merge box's one status
// (describeMergeVerdict, lib/pullRequest.ts), which says what most
// stands between the PR and landing instead of a verdict beside its
// cause.
//
// Run: pnpm test worktree-pr-header.
import assert from "node:assert/strict";
import {
  describeMergeState,
  describeMergeVerdict,
} from "@shigomori/ui/lib/pullRequest.ts";
import { titledByPullRequest, worktreeTitle } from "@/lib/worktreeTitle";
import {
  summarizeChecks,
  type PullRequest,
  type PullRequestCheckBucket,
  type PullRequestDetail,
  type PullRequestMergeState,
  type PullRequestReviews,
} from "@shigomori/contracts/schemas";
import { it } from "vitest";

const slim = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "The PR's title",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  isCrossRepository: false,
  ...over,
});

const worktree = (title?: string) => ({
  branch: "feature",
  primaryBranch: "main",
  title,
});

const detail = ({
  buckets = [],
  mergeState = "CLEAN",
  reviews,
  ...over
}: Partial<PullRequestDetail> & {
  buckets?: PullRequestCheckBucket[];
}): PullRequestDetail => {
  const checkList = buckets.map((bucket, i) => ({ name: `c${i}`, bucket }));
  return {
    ...slim(),
    mergeState,
    autoMerge: null,
    authorLogin: "someone",
    updatedAt: "2026-01-01T00:00:00Z",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    checks: summarizeChecks(checkList),
    checkList,
    reviews,
    ...over,
  };
};

// The merge box's own path: the merge state, then the verdict over it.
const verdict = (pr: PullRequestDetail, armed = false) =>
  describeMergeVerdict(
    pr,
    describeMergeState(pr.mergeState, pr.isDraft, false),
    armed,
  );

const requiredReview: PullRequestReviews = {
  decision: "REVIEW_REQUIRED",
  reviewers: [],
};

it("an open PR names the page over the worktree's own title", () => {
  const pr = slim();
  assert.equal(titledByPullRequest(worktree("Mine"), pr), true);
  assert.equal(worktreeTitle(worktree("Mine"), pr), "The PR's title");
});

it("a merged or closed PR names the page only with no title of its own", () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const pr = slim({ state });
    assert.equal(titledByPullRequest(worktree(), pr), true, state);
    assert.equal(titledByPullRequest(worktree("Mine"), pr), false, state);
    assert.equal(worktreeTitle(worktree("Mine"), pr), "Mine", state);
  }
});

it("a fork's PR, one on the primary branch, or none never names it", () => {
  assert.equal(
    titledByPullRequest(worktree(), slim({ isCrossRepository: true })),
    false,
  );
  assert.equal(
    titledByPullRequest(
      { branch: "main", primaryBranch: "main", title: undefined },
      slim(),
    ),
    false,
  );
  assert.equal(titledByPullRequest(worktree(), null), false);
  assert.equal(worktreeTitle(worktree(), undefined), null);
});

it("all clear reads as the merge state", () => {
  const v = verdict(detail({ buckets: ["passed", "passed"] }));
  assert.deepEqual(v, {
    label: "Ready to merge",
    tone: "emerald",
    by: "merge",
  });
});

it("running or failing checks speak, not the requirement", () => {
  const pending = verdict(
    detail({ buckets: ["pending", "passed"], mergeState: "BLOCKED" }),
  );
  assert.equal(pending.by, "checks");
  assert.equal(pending.label, "1 check pending");
  const failing = verdict(
    detail({ buckets: ["failing", "pending"], mergeState: "BLOCKED" }),
  );
  assert.equal(failing.by, "checks");
  assert.equal(failing.tone, "rose");
});

it("a review the rule wants speaks once the checks are green", () => {
  const v = verdict(
    detail({
      buckets: ["passed"],
      mergeState: "BLOCKED",
      reviews: requiredReview,
    }),
  );
  assert.deepEqual(v, {
    label: "Review required",
    tone: "amber",
    by: "reviews",
  });
  // Checks still running outrank the review.
  assert.equal(
    verdict(
      detail({
        buckets: ["pending"],
        mergeState: "BLOCKED",
        reviews: requiredReview,
      }),
    ).by,
    "checks",
  );
});

it("conflicts and drafts outrank failing checks", () => {
  const states: [Partial<PullRequestDetail>, string][] = [
    [{ mergeState: "DIRTY" as PullRequestMergeState }, "Conflicts with base"],
    [{ isDraft: true, mergeState: "DRAFT" }, "Draft"],
  ];
  for (const [over, label] of states) {
    const v = verdict(detail({ buckets: ["failing"], ...over }));
    assert.equal(v.label, label);
    assert.equal(v.by, "merge");
  }
});

it("armed auto-merge keeps its words, the checks their icon", () => {
  const pr = detail({ buckets: ["pending"], mergeState: "BLOCKED" });
  const v = describeMergeVerdict(
    pr,
    { label: "Will squash and merge when ready", tone: "amber" },
    true,
  );
  assert.deepEqual(v, {
    label: "Will squash and merge when ready",
    tone: "amber",
    by: "checks",
  });
});

it("a failing check GitHub doesn't require warns instead of blocking", () => {
  const unstable = verdict(
    detail({ buckets: ["failing", "passed"], mergeState: "UNSTABLE" }),
  );
  assert.deepEqual(unstable, {
    label: "1 check failing",
    tone: "amber",
    by: "checks",
  });
  assert.equal(
    verdict(detail({ buckets: ["failing"], mergeState: "BLOCKED" })).tone,
    "rose",
  );
});

it("armed auto-merge stays said past a review, not past a failing check", () => {
  const armedStatus = {
    label: "Will squash and merge when ready",
    tone: "amber" as const,
  };
  const waiting = describeMergeVerdict(
    detail({
      buckets: ["passed"],
      mergeState: "BLOCKED",
      reviews: requiredReview,
    }),
    armedStatus,
    true,
  );
  assert.deepEqual(waiting, { ...armedStatus, by: "merge" });
  const failing = describeMergeVerdict(
    detail({ buckets: ["failing"], mergeState: "BLOCKED" }),
    armedStatus,
    true,
  );
  assert.equal(failing.label, "1 check failing");
});
