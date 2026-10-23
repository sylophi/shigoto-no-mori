// The fake host's GitHub fixtures: the repo's pull requests by head branch
// (three of them a stack across two devices), the detail with its CI
// rollup posed by ?checks= and its reviews by ?reviews=, the merged
// stack posed by ?stack=merged, #148's state by ?prState=, and one
// diff for the diff pages. Pure data plus readers of location.search,
// served by bridge.ts.
import {
  type CommitSummary,
  type CreatePullRequestResult,
  type MergeMethod,
  type MergePullRequestResult,
  type PullRequestCheck,
  type PullRequestCandidate,
  type PullRequestCheckBucket,
  type PullRequestCompare,
  type PullRequestDraft,
  type PullRequestMergeState,
  type PullRequestOptions,
  type PullRequestReviews,
  type RepoMergeConfig,
  summarizeChecks,
} from "@shigomori/contracts/schemas";
import { armsAutoMerge } from "../lib/pullRequest.ts";
import { COMMIT_PATCH } from "./patches.ts";

const FAKE_SM_PROJECT_IDS = new Set(["p_sm", "mb_sm", "mini_sm"]);

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
// MacBook), with the bottom already landed, so the stack list, the
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

// The open PRs the new-worktree form offers as sources, by when they
// last moved: the repo's open ones, a draft, and one from a fork.
export function fakePullRequestCandidates(): PullRequestCandidate[] {
  const HOUR = 3_600_000;
  const at = (hoursAgo: number) =>
    new Date(Date.now() - hoursAgo * HOUR).toISOString();
  const open = Object.entries(FAKE_PRS)
    .filter(([, pr]) => pr.state === "OPEN")
    .map(([headRefName, pr], i) => ({
      number: pr.number,
      url: pr.url,
      title: pr.title,
      isDraft: false,
      headRefName,
      authorLogin: "sylophi",
      fromFork: false,
      headRepo: null,
      updatedAt: at(2 + i * 5),
    }));
  return [
    {
      number: 158,
      url: "https://github.com/sylophi/shigoto-no-mori/pull/158",
      title: "Show the villager's house in the worktree header",
      isDraft: true,
      headRefName: "villager-house-header",
      authorLogin: "sylophi",
      fromFork: false,
      headRepo: null,
      updatedAt: at(1),
    },
    ...open,
    {
      number: 156,
      url: "https://github.com/sylophi/shigoto-no-mori/pull/156",
      title: "Read the ports file on Windows",
      isDraft: false,
      headRefName: "windows-ports",
      authorLogin: "kokoro-dev",
      fromFork: true,
      headRepo: "kokoro-dev/shigoto-no-mori",
      updatedAt: at(30),
    },
  ];
}

const FAKE_PR_BRANCH = "v2-exp/remote-ui-flows";
const FAKE_PR_SLIM = FAKE_PRS[FAKE_PR_BRANCH];

// The PRs the create pull request dialog made this session, by head
// branch, and their descriptions by number.
const createdPullRequests: Record<string, typeof FAKE_PR_SLIM> = {};
const createdBodies: Record<number, string> = {};

export function fakeCreatePullRequest(opts: {
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}): CreatePullRequestResult {
  const number = 153 + Object.keys(createdPullRequests).length;
  const pr = {
    ...fakePullRequest(number, opts.title, opts.base),
    isDraft: opts.draft,
  };
  createdPullRequests[opts.branch] = pr;
  createdBodies[number] = opts.body;
  return { url: pr.url, warning: null };
}

// Where the create pull request dialog starts: quiet-quail's branch
// sits on gentle-gecko's in the stack, so that's its base, and the fill
// is a newest commit's subject. shigoto-no-mori has a short template.
export function fakePullRequestDraft(
  projectId: string,
  worktree: { branch: string; recentCommits: readonly CommitSummary[] },
): PullRequestDraft {
  return {
    suggestedBase:
      worktree.branch === "port-pool-retry" ? "exp/terrier-sync" : null,
    fill: { title: worktree.recentCommits[0]?.subject ?? "", body: "" },
    template: FAKE_SM_PROJECT_IDS.has(projectId)
      ? "## What changed\n\n\n## How it was checked\n\n- [ ] `pnpm test`\n"
      : null,
  };
}

// The row's own commits against any base, with totals that add up.
export function fakePullRequestCompare(
  commits: readonly CommitSummary[],
): PullRequestCompare {
  return {
    commits: commits.length,
    files: commits.length * 3,
    additions: commits.reduce((sum, c) => sum + c.additions, 0),
    deletions: commits.reduce((sum, c) => sum + c.deletions, 0),
  };
}

export const FAKE_PULL_REQUEST_OPTIONS: PullRequestOptions = {
  viewer: "sylophi",
  people: [
    { login: "sylophi", name: "Sylophi" },
    { login: "rin", name: "Rin Takeda" },
    { login: "mossgrove", name: null },
    { login: "kestrel-dev", name: "Kestrel" },
    { login: "hollyfern", name: "Holly Fern" },
  ],
  labels: [
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    { name: "design", color: "c5def5", description: null },
    {
      name: "documentation",
      color: "0075ca",
      description: "Improvements or additions to documentation",
    },
    {
      name: "enhancement",
      color: "a2eeef",
      description: "New feature or request",
    },
    { name: "good first issue", color: "7057ff", description: null },
    { name: "needs-review", color: "fbca04", description: null },
  ],
};

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

function prStatePose(params: URLSearchParams) {
  const key = params.get("prState");
  return key ? FAKE_PR_STATE_POSES[key] : undefined;
}

// The titles and bodies `sm describe` gave open PRs this session, by
// head branch.
const editedPullRequests: Record<string, { title?: string; body?: string }> =
  {};

// What `sm describe` does to the branch's open PR: answers whether
// there was one to take the edit.
export function fakeEditPullRequest(
  projectId: string,
  branch: string,
  edit: { title?: string; body?: string },
): boolean {
  if (fakePullRequests(projectId)[branch]?.state !== "OPEN") return false;
  if (edit.title === "") throw new Error("The pull request needs a title.");
  editedPullRequests[branch] = {
    ...editedPullRequests[branch],
    ...(edit.title !== undefined && { title: edit.title }),
    ...(edit.body !== undefined && { body: edit.body }),
  };
  return true;
}

function posedPullRequestMap(
  params: URLSearchParams,
): Record<string, typeof FAKE_PR_SLIM> {
  const merged = params.get("stack") === "merged";
  const prs: Record<string, typeof FAKE_PR_SLIM> = {
    ...(merged ? FAKE_PRS_MERGED : FAKE_PRS),
    ...createdPullRequests,
  };
  for (const [branch, { title }] of Object.entries(editedPullRequests)) {
    const pr = prs[branch];
    if (pr && title !== undefined) prs[branch] = { ...pr, title };
  }
  const pose = prStatePose(params);
  if (!pose) return prs;
  // The slim map carries no merge state.
  const { mergeState: _, ...slim } = pose;
  return {
    ...prs,
    [FAKE_PR_BRANCH]: { ...FAKE_PR_SLIM, ...prs[FAKE_PR_BRANCH], ...slim },
  };
}

// A project's pull requests as they stand unposed, for a picture with
// no URL to pose by (../scenes).
export function unposedPullRequests(projectId: string) {
  return FAKE_SM_PROJECT_IDS.has(projectId) ? FAKE_PRS : {};
}

// The map as the host leaves it, a merge made here included (the host
// writes the page's merged read into it).
export function fakePullRequests(projectId: string) {
  if (!FAKE_SM_PROJECT_IDS.has(projectId)) return {};
  const map = posedPullRequestMap(new URLSearchParams(location.search));
  const merged = fakeMerged ? map[FAKE_PR_BRANCH] : undefined;
  return merged === undefined
    ? map
    : { ...map, [FAKE_PR_BRANCH]: { ...merged, state: "MERGED" as const } };
}

// A branch's PR as a query's poses (?checks=, ?reviews=, ?prState=,
// ?stack=) give it, for a picture posed without a URL (../scenes).
// The stacked PRs carry no checks, so the stack poses with and without
// the checks chip. #148 carries whatever ?checks= poses.
export function posedPullRequestDetail(branch: string, query = "") {
  const params = new URLSearchParams(query);
  const slim = posedPullRequestMap(params)[branch];
  if (!slim) return null;
  const edited = editedPullRequests[branch];
  if (branch === FAKE_PR_BRANCH) return { ...posedDetail(params), ...edited };
  return {
    ...FAKE_PR_DETAIL,
    ...slim,
    body:
      edited?.body ??
      FAKE_STACK_BODIES[slim.number] ??
      createdBodies[slim.number] ??
      "",
    ...(slim.isDraft && { mergeState: "DRAFT" as const }),
    ...fakeChecks([]),
  };
}

export function fakePullRequestDetail(branch: string) {
  return branch === FAKE_PR_BRANCH
    ? { ...fakePosedDetail(), ...editedPullRequests[branch] }
    : posedPullRequestDetail(branch, location.search);
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

function posedDetail(params: URLSearchParams) {
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
    ...prStatePose(params),
  };
}

// #148 as the page's URL poses it, after whatever its merge button did.
function fakePosedDetail() {
  const posed = posedDetail(new URLSearchParams(location.search));
  return {
    ...posed,
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

// Four files, so the diff pages pose a real file index (the list in
// the sidebar on a wide viewport) and the phone's sheet, which needs a
// patch of at least DiffPage's SHEET_MIN_FILES. One is an image, for
// the preview of its two sides (fakeBlob in filesFixtures.ts). Git's
// own output (patches.ts).
export const FAKE_DIFF = COMMIT_PATCH;
