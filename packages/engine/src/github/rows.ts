// A pull request as gh's `pr list` and `pr view` answer it, and which of
// a branch's is its own: what every pull request read decodes and picks
// with.
import {
  isBranchsOwn,
  PullRequestSchema,
} from "@shigomori/contracts/schemas/pullRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as GoJson from "../goJson.ts";
import { CheckNode, checkVerdict } from "../mergeProgress.ts";

// GitHub's record of an armed auto-merge, the method as GraphQL spells
// it (MERGE, SQUASH, REBASE).
type AutoMergeRequest = { readonly mergeMethod: string };

// A pull request as `sm --json` documents print it. The optional fields
// are left out when empty, as Go's omitempty does.
export type PullRequestSummary = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly isCrossRepository?: true;
  readonly mergeStateStatus?: string;
  readonly autoMergeRequest?: AutoMergeRequest;
};

type PullRequestChecks = {
  readonly total: number;
  readonly passing: number;
  readonly failing: number;
  readonly pending: number;
};

// The status card's pull request: the summary and its check rollup.
export type PullRequestCard = PullRequestSummary & {
  readonly checks?: PullRequestChecks;
};

// A row, read as goJson.ts reads it: a field gh wasn't asked for is at
// its zero.
const Row = Schema.Struct({
  number: GoJson.count,
  title: GoJson.text,
  state: GoJson.text,
  isDraft: GoJson.flag,
  url: GoJson.text,
  baseRefName: GoJson.text,
  headRefName: GoJson.text,
  headRefOid: GoJson.text,
  isCrossRepository: GoJson.flag,
  mergeStateStatus: GoJson.text,
  body: GoJson.text,
  autoMergeRequest: Schema.optional(
    Schema.NullOr(Schema.Struct({ mergeMethod: GoJson.text })),
  ),
  author: GoJson.struct(Schema.Struct({ login: GoJson.text })),
  updatedAt: GoJson.text,
  additions: GoJson.count,
  deletions: GoJson.count,
  changedFiles: GoJson.count,
  // Each check with the link its integration wrote, a CheckRun's
  // detailsUrl or a StatusContext's targetUrl.
  statusCheckRollup: GoJson.list(
    Schema.Struct({
      ...CheckNode.fields,
      detailsUrl: GoJson.text,
      targetUrl: GoJson.text,
    }),
  ),
});
export type PullRequestRow = typeof Row.Type;

export const rowOf = Schema.decodeUnknownOption(Schema.fromJsonString(Row));
export const rowsOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Row)),
);

// Rows read for a pull request's page, where every row must have what
// the page shows: one that lacks it fails the read rather than show a
// zero.
export const detailRowsOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        ...Row.fields,
        number: PullRequestSchema.fields.number,
        url: PullRequestSchema.fields.url,
        title: Schema.String,
        state: PullRequestSchema.fields.state,
        isDraft: Schema.Boolean,
        baseRefName: Schema.String,
        updatedAt: Schema.String,
        additions: Schema.Natural,
        deletions: Schema.Natural,
        changedFiles: Schema.Natural,
      }),
    ),
  ),
);

export const SUMMARY_FIELDS =
  "number,title,state,isDraft,url,baseRefName,headRefName,isCrossRepository";

// The summary and what a pull request's page shows beside it.
export const DETAIL_FIELDS = [
  SUMMARY_FIELDS,
  "body,mergeStateStatus,autoMergeRequest,author,updatedAt,additions,deletions,changedFiles,statusCheckRollup",
];

// How a branch's pull request is found: gh's server-side --head filter,
// newest first. A few, not one: the filter matches the name across every
// fork, so a stranger's fork PR of the same name may be newer than the
// branch's own.
export const lookupArgs = (
  branch: string,
  state: "all" | "open" | "merged",
  fields: ReadonlyArray<string>,
) => [
  "pr",
  "list",
  "--state",
  state,
  "--head",
  branch,
  "--limit",
  "10",
  "--json",
  fields.join(","),
];

// The row as the document has it: the empty fields left out.
export const summaryOf = (row: PullRequestRow): PullRequestSummary => ({
  number: row.number,
  title: row.title,
  state: row.state,
  isDraft: row.isDraft,
  url: row.url,
  baseRefName: row.baseRefName,
  headRefName: row.headRefName,
  ...(row.isCrossRepository ? { isCrossRepository: true as const } : {}),
  ...(row.mergeStateStatus === ""
    ? {}
    : { mergeStateStatus: row.mergeStateStatus }),
  ...(row.autoMergeRequest
    ? { autoMergeRequest: { mergeMethod: row.autoMergeRequest.mergeMethod } }
    : {}),
});

// One node is one verdict (checkVerdict).
export const rollupChecks = (
  nodes: ReadonlyArray<CheckNode>,
): PullRequestChecks => {
  const checks = { total: 0, passing: 0, failing: 0, pending: 0 };
  for (const node of nodes) {
    checks.total++;
    checks[checkVerdict(node)]++;
  }
  return checks;
};

// Each branch's own pull request among `rows`, newest first: the first
// that is from this repository, or is the fork's one the branch was
// checked out from (`checkedOut`, by branch).
export const ownByBranch = <
  A extends {
    readonly number: number;
    readonly headRefName: string;
    readonly isCrossRepository?: boolean;
  },
>(
  rows: ReadonlyArray<A>,
  checkedOut: ReadonlyMap<string, number>,
): ReadonlyMap<string, A> => {
  const own = new Map<string, A>();
  for (const row of rows) {
    if (
      !own.has(row.headRefName) &&
      isBranchsOwn(row, checkedOut.get(row.headRefName))
    ) {
      own.set(row.headRefName, row);
    }
  }
  return own;
};

// The branch's own of rows gh found by its name (lookupArgs).
export const ownOf = (
  rows: ReadonlyArray<PullRequestRow>,
  branch: string,
  checkedOut: ReadonlyMap<string, number>,
) => Option.fromNullishOr(ownByBranch(rows, checkedOut).get(branch));
