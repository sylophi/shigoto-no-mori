// Where an open pull request stands on its way to merging, as the wait
// for an armed auto-merge or a merge queue reads it (Landing.ts), and
// what a check's state comes to.

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

export type CheckVerdict = "passing" | "failing" | "pending";

const text = (value: unknown) => (typeof value === "string" ? value : "");

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// gh's check rollup mixes CheckRun nodes (status and conclusion) and
// StatusContext nodes (state). One node is one verdict.
export function checkVerdict(node: unknown): CheckVerdict {
  const fields = isObject(node) ? node : {};
  let verdict = text(fields["state"]);
  if (verdict === "") {
    verdict =
      text(fields["status"]) === "COMPLETED"
        ? text(fields["conclusion"])
        : "PENDING";
  }
  return PASSING.has(verdict)
    ? "passing"
    : FAILING.has(verdict)
      ? "failing"
      : "pending";
}

export type MergeProgress = {
  readonly state: string;
  readonly mergeStateStatus: string;
  readonly reviewDecision: string;
  readonly isInMergeQueue: boolean;
  // The method an armed auto-merge merges with, absent when none is
  // armed.
  readonly autoMergeMethod?: string;
  // The head commit's checks.
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly verdict: CheckVerdict;
    readonly required: boolean;
  }>;
};

// GraphQL, since `gh pr view --json` exposes neither isInMergeQueue nor
// whether a check is required. isRequired is what lets the wait go on
// past a failing check GitHub merges past anyway. The number goes first
// so a test's fake gh can tell this query from the repo settings' by
// its prefix.
export const MERGE_PROGRESS_QUERY =
  "query($number: Int!, $owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
  "{ pullRequest(number: $number) { state mergeStateStatus reviewDecision isInMergeQueue autoMergeRequest { mergeMethod } " +
  "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { " +
  "... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) } " +
  "... on StatusContext { context state isRequired(pullRequestNumber: $number) } } } } } } } } } }";

// The query's answer, or undefined when it isn't one.
export function parseMergeProgress(stdout: string): MergeProgress | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const data = isObject(parsed) ? parsed["data"] : undefined;
  const repository = isObject(data) ? data["repository"] : undefined;
  const pr = isObject(repository) ? repository["pullRequest"] : undefined;
  if (!isObject(pr)) return undefined;
  const armed = pr["autoMergeRequest"];
  const commits = isObject(pr["commits"]) ? pr["commits"]["nodes"] : [];
  const checks: Array<MergeProgress["checks"][number]> = [];
  for (const commit of Array.isArray(commits) ? commits : []) {
    const rollup =
      isObject(commit) && isObject(commit["commit"])
        ? commit["commit"]["statusCheckRollup"]
        : undefined;
    const contexts =
      isObject(rollup) && isObject(rollup["contexts"])
        ? rollup["contexts"]["nodes"]
        : [];
    for (const node of Array.isArray(contexts) ? contexts : []) {
      const fields = isObject(node) ? node : {};
      checks.push({
        name: text(fields["name"]) || text(fields["context"]),
        verdict: checkVerdict(node),
        required: fields["isRequired"] === true,
      });
    }
  }
  return {
    state: text(pr["state"]),
    mergeStateStatus: text(pr["mergeStateStatus"]),
    reviewDecision: text(pr["reviewDecision"]),
    isInMergeQueue: pr["isInMergeQueue"] === true,
    ...(isObject(armed) ? { autoMergeMethod: text(armed["mergeMethod"]) } : {}),
    checks,
  };
}

const requiredChecks = (progress: MergeProgress, verdict: CheckVerdict) =>
  progress.checks
    .filter((check) => check.required && check.verdict === verdict)
    .map(({ name }) => name);

// Why GitHub won't merge the PR without a person, or "" while it still
// might. GitHub doesn't update a branch that is behind for auto-merge,
// so BEHIND waits on a person too. A merge queue brings the PR up to
// date and runs its checks itself, so a queued PR waits on the queue.
// `queued` is whether the PR has been in one, which takes it out again
// when its checks fail.
export function mergeProblem(
  progress: MergeProgress,
  base: string,
  queued: boolean,
): string {
  if (progress.state === "CLOSED") return "it was closed";
  if (progress.isInMergeQueue) return "";
  if (progress.autoMergeMethod === undefined) {
    return queued
      ? "it left the merge queue unmerged"
      : "auto-merge was turned off";
  }
  if (progress.mergeStateStatus === "DIRTY") return `it conflicts with ${base}`;
  if (progress.mergeStateStatus === "BEHIND") {
    return `it is behind ${base} and needs updating`;
  }
  if (progress.reviewDecision === "CHANGES_REQUESTED") {
    return "changes were requested";
  }
  const failed = requiredChecks(progress, "failing");
  if (failed.length === 1) return `check ${failed[0]} failed`;
  if (failed.length > 1) return `checks ${failed.join(", ")} failed`;
  return "";
}

// What the PR waits on, or "" when nothing the reads can see.
export function mergeWaitingOn(progress: MergeProgress): string {
  if (progress.isInMergeQueue) return "it is in the merge queue";
  if (requiredChecks(progress, "pending").length > 0) {
    return "checks are running";
  }
  if (progress.reviewDecision === "REVIEW_REQUIRED") return "it needs a review";
  return "";
}
