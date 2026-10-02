// The lab's GitHub fixtures: the repo's pull requests by head branch
// (three of them a stack across two devices), the detail with its CI
// rollup posed by ?checks=, the merged stack posed by ?stack=merged,
// and one diff for the diff pages. Pure data plus readers of
// location.search, served by bridge.ts.
import {
  type MergeMethod,
  type MergePullRequestResult,
  type PullRequestCheck,
  type PullRequestCheckBucket,
  type PullRequestMergeState,
  type RepoMergeConfig,
  summarizeChecks,
} from "@shared/schemas";
import { armsAutoMerge } from "@/lib/pullRequest";

const LAB_SM_PROJECT_IDS = new Set(["p_sm", "tp_sm", "mini_sm"]);

const labPullRequest = (
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
const LAB_PRS = {
  "v2-exp/remote-ui-flows": labPullRequest(
    148,
    "Aggregate worktrees across devices",
    "main",
  ),
  "fix-stale-locks": labPullRequest(
    150,
    "Refuse a lock file older than the daemon",
    "main",
    "MERGED",
  ),
  "exp/terrier-sync": labPullRequest(
    151,
    "Watch the terrier registry for edits",
    "fix-stale-locks",
  ),
  "port-pool-retry": labPullRequest(
    152,
    "Retry the pool lease before giving up",
    "exp/terrier-sync",
  ),
};

const LAB_PR_SLIM = LAB_PRS["v2-exp/remote-ui-flows"];

// ?stack=merged poses the whole stack as landed, so the closed-PR box
// offers the stack cleanup (the merged layers' worktrees together).
const LAB_STACK_BRANCHES = new Set([
  "fix-stale-locks",
  "exp/terrier-sync",
  "port-pool-retry",
]);
const LAB_PRS_MERGED = Object.fromEntries(
  Object.entries(LAB_PRS).map(([branch, pr]) => [
    branch,
    LAB_STACK_BRANCHES.has(branch) ? { ...pr, state: "MERGED" as const } : pr,
  ]),
);

function labPosedPullRequests(): Record<string, typeof LAB_PR_SLIM> {
  const merged = new URLSearchParams(location.search).get("stack") === "merged";
  return merged ? LAB_PRS_MERGED : LAB_PRS;
}

export function labPullRequests(projectId: string) {
  return LAB_SM_PROJECT_IDS.has(projectId) ? labPosedPullRequests() : {};
}

// The stacked PRs carry no checks, so the stack poses with and without
// the checks chip. #148 carries whatever ?checks= poses.
export function labPullRequestDetail(branch: string) {
  const slim = labPosedPullRequests()[branch];
  if (!slim) return null;
  if (slim === LAB_PR_SLIM) return labPosedChecksDetail();
  return { ...LAB_PR_DETAIL, ...slim, ...labChecks([]) };
}

const labCheck = (
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

const labChecks = (checkList: PullRequestCheck[]) => ({
  checks: summarizeChecks(checkList),
  checkList,
});

// One CI run, all passing: the poses below set a few jobs' buckets.
const labCiRun = (
  buckets: Partial<Record<string, PullRequestCheckBucket>> = {},
) => [
  ...[
    "typecheck",
    "lint",
    "test (macos-latest)",
    "test (ubuntu-latest)",
    "theme:check",
  ].map((name) => labCheck(name, buckets[name] ?? "passed")),
  labCheck("Vercel", buckets["Vercel"] ?? "passed", false),
];

// ?checks=<variant> poses #148's CI rollup, paired with the merge state
// GitHub would report beside it, and for `auto-merge` the auto-merge
// armed while the checks run. Unknown or absent keeps the default two
// passing checks.
const LAB_CHECK_POSES: Record<
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
    checkList: [labCheck("battery", "passed")],
  },
  "single-failing": {
    mergeState: "UNSTABLE",
    checkList: [labCheck("battery", "failing")],
  },
  passed: { mergeState: "CLEAN", checkList: labCiRun() },
  "passed-some-skipped": {
    mergeState: "CLEAN",
    checkList: [
      ...labCiRun().slice(0, 4),
      labCheck("release-mac", "skipped"),
      labCheck("CodeQL", "neutral"),
    ],
  },
  "all-skipped": {
    mergeState: "CLEAN",
    checkList: [
      labCheck("release-mac", "skipped"),
      labCheck("web-client-prod", "skipped"),
      labCheck("CodeQL", "neutral"),
    ],
  },
  pending: {
    mergeState: "BLOCKED",
    checkList: labCiRun({
      "test (macos-latest)": "pending",
      "test (ubuntu-latest)": "pending",
      Vercel: "pending",
    }),
  },
  "auto-merge": {
    mergeState: "BLOCKED",
    autoMerge: "squash",
    checkList: labCiRun({
      "test (macos-latest)": "pending",
      "test (ubuntu-latest)": "pending",
    }),
  },
  failing: {
    mergeState: "UNSTABLE",
    checkList: labCiRun({ lint: "failing" }),
  },
  "failing-blocked": {
    mergeState: "BLOCKED",
    checkList: labCiRun({
      typecheck: "failing",
      "test (macos-latest)": "failing",
      "test (ubuntu-latest)": "failing",
    }),
  },
  "failing-and-pending": {
    mergeState: "BLOCKED",
    checkList: [
      ...labCiRun({
        lint: "failing",
        "test (macos-latest)": "pending",
        "test (ubuntu-latest)": "pending",
      }).slice(0, 5),
      labCheck("release-mac", "skipped"),
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
      ].map((name) => labCheck(name, "passed")),
      labCheck(
        "e2e / web shell on a narrow phone viewport with the inbox open",
        "failing",
      ),
      labCheck("build (linux-x64)", "pending"),
      labCheck("build (win32-x64)", "pending"),
      labCheck("release-mac", "skipped"),
      labCheck("web-client-prod", "skipped"),
      labCheck("CodeQL", "neutral"),
      labCheck("Vercel (shigomori-web)", "passed", false),
      labCheck("Vercel (shigomori-site)", "passed", false),
    ],
  },
};

function labPosedChecksDetail() {
  const variant = new URLSearchParams(location.search).get("checks");
  const pose = variant ? LAB_CHECK_POSES[variant] : undefined;
  const posed = pose
    ? {
        ...LAB_PR_DETAIL,
        mergeState: pose.mergeState,
        autoMerge: pose.autoMerge ?? null,
        ...labChecks(pose.checkList),
      }
    : LAB_PR_DETAIL;
  return {
    ...posed,
    state: labMerged ? ("MERGED" as const) : posed.state,
    autoMerge: labAutoMerge ? labAutoMerge.method : posed.autoMerge,
  };
}

// Every method allowed, so the merge button poses its dropdown, and
// auto-merge too, so a waiting PR (?checks=pending) poses the
// auto-merge button.
export const LAB_REPO_MERGE_CONFIG: RepoMergeConfig = {
  merge: true,
  squash: true,
  rebase: true,
  autoMerge: true,
};

// What the lab's merge button does, by the button's own rule: a PR it
// would arm auto-merge for reads as armed with the method until
// "Disable auto-merge". Anything else merges, and reads as merged.
// Page state, so the flow can be posed and recorded. A reload starts
// over.
let labAutoMerge: { method: MergeMethod | null } | null = null;
let labMerged = false;

export function labMergePullRequest(
  method: MergeMethod,
): MergePullRequestResult {
  if (armsAutoMerge(LAB_REPO_MERGE_CONFIG, labPosedChecksDetail(), false)) {
    labAutoMerge = { method };
    return { outcome: "auto-merge" };
  }
  labMerged = true;
  return { outcome: "merged" };
}

export function labDisableAutoMerge(): void {
  labAutoMerge = { method: null };
}

const LAB_PR_DETAIL = {
  ...LAB_PR_SLIM,
  mergeState: "CLEAN" as PullRequestMergeState,
  autoMerge: null as MergeMethod | null,
  authorLogin: "sylophi",
  updatedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  additions: 412,
  deletions: 96,
  changedFiles: 14,
  ...labChecks([
    { name: "battery", bucket: "passed" },
    { name: "theme:check", bucket: "passed" },
  ]),
};

// Three files, so the diff pages pose a real file index (the list in
// the sidebar on a wide viewport) and the phone's sheet, which needs a
// patch of at least DiffView's SHEET_MIN_FILES.
export const LAB_DIFF = `diff --git a/renderer/components/sidebar/RowContent.tsx b/renderer/components/sidebar/RowContent.tsx
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
