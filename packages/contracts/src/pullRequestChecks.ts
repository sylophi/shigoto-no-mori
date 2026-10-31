// What one check in gh's rollup comes to, read the same way by the pull
// request panel and by the engine's wait for a merge.
import type { PullRequestCheckBucket } from "./schemas/pullRequest.ts";

// A CheckRun carries a status, then a conclusion. A StatusContext only
// carries a state. gh leaves out what a node lacks, or sends it empty.
export type CheckState = {
  readonly state?: string | undefined;
  readonly status?: string | undefined;
  readonly conclusion?: string | undefined;
};

const FAILING = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "CANCELLED",
  // GitHub's mark for a check left incomplete for two weeks: waiting
  // won't pass it.
  "STALE",
]);

// A finished check with a verdict this build doesn't know is pending,
// so nothing merges on a signal it can't read.
export function checkBucket(check: CheckState): PullRequestCheckBucket {
  if (check.state) {
    if (check.state === "SUCCESS") return "passed";
    return FAILING.has(check.state) ? "failing" : "pending";
  }
  if (check.status && check.status !== "COMPLETED") return "pending";
  switch (check.conclusion) {
    case "SUCCESS":
      return "passed";
    case "NEUTRAL":
      return "neutral";
    case "SKIPPED":
      return "skipped";
    default:
      return FAILING.has(check.conclusion ?? "") ? "failing" : "pending";
  }
}
