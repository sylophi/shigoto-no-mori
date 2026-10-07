// The fake host's GitHub fixtures: the repo's pull requests by head branch
// (three of them a stack across two devices), the detail with its CI
// rollup posed by ?checks= and its reviews by ?reviews=, the merged
// stack posed by ?stack=merged, #148's state by ?prState=, and one
// diff for the diff pages. Pure data plus readers of location.search,
// served by bridge.ts.
import {
  type MergeMethod,
  type MergePullRequestResult,
  type PullRequestCheck,
  type PullRequestCheckBucket,
  type PullRequestMergeState,
  type PullRequestReviews,
  type RepoMergeConfig,
  summarizeChecks,
} from "@shared/schemas";
import { armsAutoMerge } from "@/lib/pullRequest";

const FAKE_SM_PROJECT_IDS = new Set(["p_sm", "tp_sm", "mini_sm"]);

const fakePullRequest = (
  number: number,
  title: string,
  baseRefName: string,
  state: "OPEN" | "MERGED" | "CLOSED" = "OPEN",
) => ({
  number,
  url: `https://github.com/sylophi/shigoto-no-mori/pull/${number}`,
  title,
  state,
  isDraft: false,
  baseRefName,
});

// The repo's PRs by head branch. Three of them are a stack across two
// devices (brave-badger and quiet-quail here, gentle-gecko on the
// Thinkpad), with the bottom already landed, so the stack list, the
// pill positions and the "merge up to here" button all pose.
const FAKE_PRS = {
  "v2-exp/remote-ui-flows": fakePullRequest(
    148,
    "Aggregate worktrees across devices",
    "main",
  ),
  "fix-stale-locks": fakePullRequest(
    150,
    "Refuse a lock file older than the daemon",
    "main",
    "MERGED",
  ),
  "exp/terrier-sync": fakePullRequest(
    151,
    "Watch the terrier registry for edits",
    "fix-stale-locks",
  ),
  "port-pool-retry": fakePullRequest(
    152,
    "Retry the pool lease before giving up",
    "exp/terrier-sync",
  ),
};

const FAKE_PR_BRANCH = "v2-exp/remote-ui-flows";
const FAKE_PR_SLIM = FAKE_PRS[FAKE_PR_BRANCH];

// ?stack=merged poses the whole stack as landed, so the closed-PR box
// offers the stack cleanup (the merged layers' worktrees together).
const FAKE_STACK_BRANCHES = new Set([
  "fix-stale-locks",
  "exp/terrier-sync",
  "port-pool-retry",
]);
const FAKE_PRS_MERGED = Object.fromEntries(
  Object.entries(FAKE_PRS).map(([branch, pr]) => [
    branch,
    FAKE_STACK_BRANCHES.has(branch) ? { ...pr, state: "MERGED" as const } : pr,
  ]),
);

// ?prState=<pose> poses #148 in a state the CI poses don't reach: a
// draft, closed without merging, conflicting with its base, or behind
// it. Unknown or absent keeps it open.
const FAKE_PR_STATE_POSES: Record<
  string,
  { state?: "CLOSED"; isDraft?: true; mergeState?: PullRequestMergeState }
> = {
  draft: { isDraft: true, mergeState: "DRAFT" },
  closed: { state: "CLOSED" },
  conflicts: { mergeState: "DIRTY" },
  behind: { mergeState: "BEHIND" },
};

function fakePrStatePose() {
  const key = new URLSearchParams(location.search).get("prState");
  return key ? FAKE_PR_STATE_POSES[key] : undefined;
}

function fakePosedPullRequests(): Record<string, typeof FAKE_PR_SLIM> {
  const merged = new URLSearchParams(location.search).get("stack") === "merged";
  const prs = merged ? FAKE_PRS_MERGED : FAKE_PRS;
  const pose = fakePrStatePose();
  if (!pose) return prs;
  // The slim map carries no merge state.
  const { mergeState: _, ...slim } = pose;
  return { ...prs, [FAKE_PR_BRANCH]: { ...FAKE_PR_SLIM, ...slim } };
}

export function fakePullRequests(projectId: string) {
  return FAKE_SM_PROJECT_IDS.has(projectId) ? fakePosedPullRequests() : {};
}

// The stacked PRs carry no checks, so the stack poses with and without
// the checks chip. #148 carries whatever ?checks= poses.
export function fakePullRequestDetail(branch: string) {
  const slim = fakePosedPullRequests()[branch];
  if (!slim) return null;
  if (branch === FAKE_PR_BRANCH) return fakePosedDetail();
  return {
    ...FAKE_PR_DETAIL,
    ...slim,
    body: FAKE_STACK_BODIES[slim.number] ?? "",
    ...fakeChecks([]),
  };
}

// The stacked PRs' own descriptions, so each page shows its PR's.
const FAKE_STACK_BODIES: Record<number, string> = {
  150: "A lock file older than the running daemon is a leftover, so it is refused instead of waited on.",
  151: "Reloads the project list when terrier's registry changes on disk.",
  152: [
    "Retries a busy pool lease a few times before reporting it taken.",
    "",
    "- [x] Retry with backoff",
    "- [ ] Say which process holds the lease",
    "",
    "| Attempts | Wait |",
    "| --- | --- |",
    "| 1-3 | 100ms |",
    "| 4-5 | 500ms |",
  ].join("\n"),
};

const fakeCheck = (
  name: string,
  bucket: PullRequestCheckBucket,
  linked = true,
): PullRequestCheck => ({
  name,
  bucket,
  ...(linked && {
    url: `https://github.com/sylophi/shigoto-no-mori/actions/runs/9120#${encodeURIComponent(name)}`,
  }),
});

const fakeChecks = (checkList: PullRequestCheck[]) => ({
  checks: summarizeChecks(checkList),
  checkList,
});

// One CI run, all passing: the poses below set a few jobs' buckets.
const fakeCiRun = (
  buckets: Partial<Record<string, PullRequestCheckBucket>> = {},
) => [
  ...[
    "typecheck",
    "lint",
    "test (macos-latest)",
    "test (ubuntu-latest)",
    "theme:check",
  ].map((name) => fakeCheck(name, buckets[name] ?? "passed")),
  fakeCheck("Vercel", buckets["Vercel"] ?? "passed", false),
];

// ?checks=<variant> poses #148's CI rollup, paired with the merge state
// GitHub would report beside it, and for `auto-merge` the auto-merge
// armed while the checks run. Unknown or absent keeps the default two
// passing checks.
const FAKE_CHECK_POSES: Record<
  string,
  {
    mergeState: PullRequestMergeState;
    checkList: PullRequestCheck[];
    autoMerge?: MergeMethod;
  }
> = {
  none: { mergeState: "CLEAN", checkList: [] },
  "single-passed": {
    mergeState: "CLEAN",
    checkList: [fakeCheck("battery", "passed")],
  },
  "single-failing": {
    mergeState: "UNSTABLE",
    checkList: [fakeCheck("battery", "failing")],
  },
  passed: { mergeState: "CLEAN", checkList: fakeCiRun() },
  "passed-some-skipped": {
    mergeState: "CLEAN",
    checkList: [
      ...fakeCiRun().slice(0, 4),
      fakeCheck("release-mac", "skipped"),
      fakeCheck("CodeQL", "neutral"),
    ],
  },
  "all-skipped": {
    mergeState: "CLEAN",
    checkList: [
      fakeCheck("release-mac", "skipped"),
      fakeCheck("web-client-prod", "skipped"),
      fakeCheck("CodeQL", "neutral"),
    ],
  },
  pending: {
    mergeState: "BLOCKED",
    checkList: fakeCiRun({
      "test (macos-latest)": "pending",
      "test (ubuntu-latest)": "pending",
      Vercel: "pending",
    }),
  },
  "auto-merge": {
    mergeState: "BLOCKED",
    autoMerge: "squash",
    checkList: fakeCiRun({
      "test (macos-latest)": "pending",
      "test (ubuntu-latest)": "pending",
    }),
  },
  failing: {
    mergeState: "UNSTABLE",
    checkList: fakeCiRun({ lint: "failing" }),
  },
  "failing-blocked": {
    mergeState: "BLOCKED",
    checkList: fakeCiRun({
      typecheck: "failing",
      "test (macos-latest)": "failing",
      "test (ubuntu-latest)": "failing",
    }),
  },
  "failing-and-pending": {
    mergeState: "BLOCKED",
    checkList: [
      ...fakeCiRun({
        lint: "failing",
        "test (macos-latest)": "pending",
        "test (ubuntu-latest)": "pending",
      }).slice(0, 5),
      fakeCheck("release-mac", "skipped"),
    ],
  },
  many: {
    mergeState: "UNSTABLE",
    checkList: [
      ...[
        "typecheck",
        "lint",
        "format:check",
        "licenses:check",
        "theme:check",
        "test (macos-latest, node 22)",
        "test (ubuntu-latest, node 22)",
        "test (windows-latest, node 22)",
        "hub / go test ./...",
        "cli / go vet ./...",
        "e2e / remote-smoke",
        "build (darwin-arm64)",
        "build (darwin-x64)",
      ].map((name) => fakeCheck(name, "passed")),
      fakeCheck(
        "e2e / web shell on a narrow phone viewport with the inbox open",
        "failing",
      ),
      fakeCheck("build (linux-x64)", "pending"),
      fakeCheck("build (win32-x64)", "pending"),
      fakeCheck("release-mac", "skipped"),
      fakeCheck("web-client-prod", "skipped"),
      fakeCheck("CodeQL", "neutral"),
      fakeCheck("Vercel (shigomori-web)", "passed", false),
      fakeCheck("Vercel (shigomori-site)", "passed", false),
    ],
  },
};

// ?reviews=<variant> poses #148's reviews. Unknown or absent keeps
// none, on a branch with no review rule, so the chip stays away.
const FAKE_REVIEW_POSES: Record<string, PullRequestReviews> = {
  approved: {
    decision: "APPROVED",
    reviewers: [
      { login: "tanuki", state: "APPROVED" },
      { login: "copilot-pull-request-reviewer", state: "COMMENTED" },
    ],
  },
  "approved-no-rule": {
    decision: null,
    reviewers: [
      { login: "tanuki", state: "APPROVED" },
      { login: "isabelle", state: "APPROVED" },
    ],
  },
  "changes-requested": {
    decision: "CHANGES_REQUESTED",
    reviewers: [
      { login: "tanuki", state: "APPROVED" },
      { login: "blathers", state: "CHANGES_REQUESTED" },
    ],
  },
  required: {
    decision: "REVIEW_REQUIRED",
    reviewers: [
      { login: "tanuki", state: "REQUESTED" },
      { login: "sylophi/maintainers", state: "REQUESTED" },
    ],
  },
  "required-unrequested": { decision: "REVIEW_REQUIRED", reviewers: [] },
  "required-partial": {
    decision: "REVIEW_REQUIRED",
    reviewers: [
      { login: "tanuki", state: "APPROVED" },
      { login: "isabelle", state: "REQUESTED" },
    ],
  },
  requested: {
    decision: null,
    reviewers: [{ login: "tanuki", state: "REQUESTED" }],
  },
  commented: {
    decision: null,
    reviewers: [{ login: "copilot-pull-request-reviewer", state: "COMMENTED" }],
  },
};

function fakePosedDetail() {
  const params = new URLSearchParams(location.search);
  const variant = params.get("checks");
  const pose = variant ? FAKE_CHECK_POSES[variant] : undefined;
  const reviewVariant = params.get("reviews");
  const reviews = reviewVariant ? FAKE_REVIEW_POSES[reviewVariant] : undefined;
  const posed = pose
    ? {
        ...FAKE_PR_DETAIL,
        mergeState: pose.mergeState,
        autoMerge: pose.autoMerge ?? null,
        ...fakeChecks(pose.checkList),
      }
    : FAKE_PR_DETAIL;
  return {
    ...posed,
    // A review the branch is waiting on blocks the merge, as on GitHub.
    ...(reviews && {
      reviews,
      ...((reviews.decision === "REVIEW_REQUIRED" ||
        reviews.decision === "CHANGES_REQUESTED") && {
        mergeState: "BLOCKED" as const,
      }),
    }),
    ...fakePrStatePose(),
    ...(fakeMerged && { state: "MERGED" as const }),
    autoMerge: fakeAutoMerge ? fakeAutoMerge.method : posed.autoMerge,
  };
}

// Every method allowed, so the merge button poses its dropdown, and
// auto-merge too, so a waiting PR (?checks=pending) poses the
// auto-merge button.
export const FAKE_REPO_MERGE_CONFIG: RepoMergeConfig = {
  merge: true,
  squash: true,
  rebase: true,
  autoMerge: true,
};

// What the fake host's merge button does, by the button's own rule: a PR it
// would arm auto-merge for reads as armed with the method until
// "Disable auto-merge". Anything else merges, and reads as merged.
// Page state, so the flow can be posed and recorded. A reload starts
// over.
let fakeAutoMerge: { method: MergeMethod | null } | null = null;
let fakeMerged = false;

export function fakeMergePullRequest(
  method: MergeMethod,
): MergePullRequestResult {
  if (armsAutoMerge(FAKE_REPO_MERGE_CONFIG, fakePosedDetail(), false)) {
    fakeAutoMerge = { method };
    return { outcome: "auto-merge" };
  }
  fakeMerged = true;
  return { outcome: "merged" };
}

export function fakeDisableAutoMerge(): void {
  fakeAutoMerge = { method: null };
}

const FAKE_PR_DETAIL = {
  ...FAKE_PR_SLIM,
  body: [
    "Lists every device's worktrees in one sidebar, each badged with the machine it lives on.",
    "",
    "- The daemons' lists merge by repo identity.",
    "- A peer that drops off keeps its last rows, faded.",
  ].join("\n"),
  mergeState: "CLEAN" as PullRequestMergeState,
  autoMerge: null as MergeMethod | null,
  authorLogin: "sylophi",
  updatedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  additions: 412,
  deletions: 96,
  changedFiles: 14,
  ...fakeChecks([
    { name: "battery", bucket: "passed" },
    { name: "theme:check", bucket: "passed" },
  ]),
};

// Three files, so the diff pages pose a real file index (the list in
// the sidebar on a wide viewport) and the phone's sheet, which needs a
// patch of at least DiffView's SHEET_MIN_FILES.
export const FAKE_DIFF = `diff --git a/renderer/components/sidebar/RowContent.tsx b/renderer/components/sidebar/RowContent.tsx
index 4f2c9d1..a91f3c7 100644
--- a/renderer/components/sidebar/RowContent.tsx
+++ b/renderer/components/sidebar/RowContent.tsx
@@ -12,6 +12,8 @@ import { WorktreeRowLabel } from "./WorktreeRow";
+import { DeviceBadge } from "./DeviceBadge";
+
 export function RowContent({ row }: { row: SidebarRow }) {
diff --git a/renderer/components/sidebar/DeviceBadge.tsx b/renderer/components/sidebar/DeviceBadge.tsx
new file mode 100644
index 0000000..5b0e77a
--- /dev/null
+++ b/renderer/components/sidebar/DeviceBadge.tsx
@@ -0,0 +1,7 @@
+import { RowTag } from "@/components/ui/row-tag";
+
+// The owning device, as a two-letter tag at the row's trailing edge.
+export function DeviceBadge({ label }: { label: string }) {
+  const short = label.slice(0, 2).toUpperCase();
+  return <RowTag title={label}>{short}</RowTag>;
+}
diff --git a/renderer/components/sidebar/WorktreeRow.tsx b/renderer/components/sidebar/WorktreeRow.tsx
index c3d8e5f..dd44ee5 100644
--- a/renderer/components/sidebar/WorktreeRow.tsx
+++ b/renderer/components/sidebar/WorktreeRow.tsx
@@ -18,7 +18,7 @@ import { useWorktreeRowState } from "./useWorktreeRowState";
 export const WORKTREE_ROW_BUTTON =
-  "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs";
+  "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors";
`;
