// Where an open pull request stands on its way to merging, as the wait
// for an armed auto-merge or a merge queue reads it (Landing.ts), and
// what a check's state comes to.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { checkBucket } from "@shigomori/contracts/pullRequestChecks";
import { flag, list, struct, text } from "./goJson.ts";

export type CheckVerdict = "passing" | "failing" | "pending";

// gh's check rollup mixes CheckRun nodes (name, status and conclusion)
// and StatusContext nodes (context and state).
export const CheckNode = Schema.Struct({
  name: text,
  context: text,
  state: text,
  status: text,
  conclusion: text,
  isRequired: flag,
});
export type CheckNode = typeof CheckNode.Type;

export function checkVerdict(node: CheckNode): CheckVerdict {
  const bucket = checkBucket(node);
  return bucket === "failing" || bucket === "pending" ? bucket : "passing";
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

const MergeProgressAnswer = Schema.fromJsonString(
  Schema.Struct({
    data: struct(
      Schema.Struct({
        repository: struct(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({
                state: text,
                mergeStateStatus: text,
                reviewDecision: text,
                isInMergeQueue: flag,
                autoMergeRequest: Schema.optional(
                  Schema.NullOr(Schema.Struct({ mergeMethod: text })),
                ),
                commits: struct(
                  Schema.Struct({
                    nodes: list(
                      Schema.Struct({
                        commit: struct(
                          Schema.Struct({
                            statusCheckRollup: struct(
                              Schema.Struct({
                                contexts: struct(
                                  Schema.Struct({ nodes: list(CheckNode) }),
                                ),
                              }),
                            ),
                          }),
                        ),
                      }),
                    ),
                  }),
                ),
              }),
            ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
          }),
        ),
      }),
    ),
  }),
);

// The query's answer, or undefined when it isn't one.
export function parseMergeProgress(stdout: string): MergeProgress | undefined {
  const answer = Schema.decodeOption(MergeProgressAnswer)(stdout);
  const pr = Option.isSome(answer)
    ? answer.value.data.repository.pullRequest
    : null;
  if (pr === null) return undefined;
  const checks = pr.commits.nodes.flatMap(({ commit }) =>
    commit.statusCheckRollup.contexts.nodes.map((node) => ({
      name: node.name || node.context,
      verdict: checkVerdict(node),
      required: node.isRequired,
    })),
  );
  return {
    state: pr.state,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    isInMergeQueue: pr.isInMergeQueue,
    ...(pr.autoMergeRequest
      ? { autoMergeMethod: pr.autoMergeRequest.mergeMethod }
      : {}),
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
