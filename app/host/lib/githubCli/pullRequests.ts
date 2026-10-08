import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  isFromThisRepository,
  type MergeMethod,
  MergeMethodSchema,
  type PullRequest,
  type PullRequestCheck,
  type PullRequestCheckBucket,
  type PullRequestDetail,
  PullRequestMergeStateSchema,
  PullRequestReviewDecisionSchema,
  PullRequestReviewerStateSchema,
  type PullRequestReviews,
  PullRequestSchema,
  PullRequestStateSchema,
  pullRequestsEqual,
  summarizeChecks,
} from "@shigomori/contracts/schemas";
import { execGh } from "./exec";
import {
  checkedOutPullRequest,
  checkedOutPullRequests,
} from "./pullRequestCheckout";
import { ghReadyForRepo } from "./GithubCli";

const GhPrListItemSchema = Schema.Struct({
  number: PullRequestSchema.fields.number,
  url: PullRequestSchema.fields.url,
  title: Schema.String,
  state: PullRequestStateSchema,
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
});
type GhPrListItem = typeof GhPrListItemSchema.Type;
const decodeGhPrList = Schema.decodeUnknownOption(
  Schema.Array(GhPrListItemSchema),
);

const PR_CACHE_TTL_MS = 5 * 60_000;
const PR_LIST_LIMIT = 200;
const prCache = new Map<
  string,
  { value: Map<string, PullRequest>; expires: number }
>();

// Runs `gh pr list ...` with the standard JSON projection. Returns the
// parsed rows on success or null on any failure (gh exit, JSON, schema).
async function runGhPrList(
  cwd: string,
): Promise<readonly GhPrListItem[] | null> {
  try {
    const { stdout } = await execGh(
      [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        String(PR_LIST_LIMIT),
        "--json",
        "number,url,title,state,isDraft,headRefName,baseRefName,isCrossRepository",
      ],
      { cwd },
    );
    const parsed: unknown = JSON.parse(stdout);
    return Option.getOrNull(decodeGhPrList(parsed));
  } catch {
    return null;
  }
}

function toPullRequest(item: GhPrListItem): PullRequest {
  return {
    number: item.number,
    url: item.url,
    title: item.title,
    state: item.state,
    isDraft: item.isDraft,
    baseRefName: item.baseRefName,
    isCrossRepository: item.isCrossRepository,
    ...checkedOutMark(item),
  };
}

// What the lookups by branch keep: a PR from this repository, or the
// fork's PR the branch it's filed under was checked out from
// (checkedOutPullRequest).
function isKept(
  pr: { number: number; isCrossRepository: boolean },
  checkedOut: number | null | undefined,
): boolean {
  return isFromThisRepository(pr) || pr.number === checkedOut;
}

// Kept fork PRs are always checked-out ones, marked so the renderer
// keeps them too (isBranchsPullRequest).
function checkedOutMark(pr: {
  isCrossRepository: boolean;
}): Pick<PullRequest, "checkedOutFrom"> {
  return isFromThisRepository(pr) ? {} : { checkedOutFrom: true };
}

// Indexed by head branch name. The cache is repopulated by the background
// sweep in fetch.ts. This read path just serves whatever's there.
// Toggle + readiness checks gate the cache too, so flipping the
// integration off takes effect immediately.
export async function listProjectPullRequests(
  cwd: string,
): Promise<Map<string, PullRequest>> {
  if (!(await ghReadyForRepo(cwd))) return new Map();
  const cached = prCache.get(cwd);
  if (cached && cached.expires > Date.now()) return cached.value;
  return refreshProjectPullRequests(cwd);
}

// Bypass the cache and repopulate. Used by the background sweep.
export async function refreshProjectPullRequests(
  cwd: string,
): Promise<Map<string, PullRequest>> {
  if (!(await ghReadyForRepo(cwd))) return cacheAndReturn(cwd, new Map());
  const [rows, checkedOut] = await Promise.all([
    runGhPrList(cwd),
    checkedOutPullRequests(cwd),
  ]);
  if (rows === null) {
    // Transient gh / network failure. Preserve the previous map so the
    // sidebar dots don't blink out on a single bad sweep. Fall through
    // to caching empty only when we've never had a value.
    const previous = prCache.get(cwd)?.value;
    return previous ?? cacheAndReturn(cwd, new Map());
  }
  // gh returns PRs newest-first; first hit per branch wins so we surface
  // the freshest PR when a branch has been reused, of those isKept.
  const map = new Map<string, PullRequest>();
  for (const item of rows) {
    if (map.has(item.headRefName)) continue;
    if (!isKept(item, checkedOut.get(item.headRefName))) continue;
    map.set(item.headRefName, toPullRequest(item));
  }
  return cacheAndReturn(cwd, map);
}

export function readCachedProjectPullRequests(
  cwd: string,
): Map<string, PullRequest> | null {
  return prCache.get(cwd)?.value ?? null;
}

export function pullRequestMapsEqual(
  a: Map<string, PullRequest> | null,
  b: Map<string, PullRequest>,
): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [branch, pa] of a) {
    const pb = b.get(branch);
    if (!pb || !pullRequestsEqual(pa, pb)) return false;
  }
  return true;
}

// Eviction hook for action paths (merge / setDraft) that change state
// the cached map reflects (isDraft, MERGED status, etc).
export function evictProjectPullRequests(cwd: string): void {
  prCache.delete(cwd);
}

function cacheAndReturn(
  cwd: string,
  value: Map<string, PullRequest>,
): Map<string, PullRequest> {
  prCache.set(cwd, { value, expires: Date.now() + PR_CACHE_TTL_MS });
  return value;
}

// Each rollup item is either a CheckRun or a StatusContext. We keep the
// schema permissive (unknown keys ignored, every field optional)
// because gh occasionally inlines extra typenames and we'd rather
// degrade gracefully than reject the whole list.
const StatusCheckRollupItemSchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  detailsUrl: Schema.optional(Schema.String),
  targetUrl: Schema.optional(Schema.String),
});
type StatusCheckRollupItem = typeof StatusCheckRollupItemSchema.Type;

const GhPrDetailSchema = Schema.Struct({
  number: PullRequestSchema.fields.number,
  url: PullRequestSchema.fields.url,
  title: Schema.String,
  body: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  isCrossRepository: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  state: PullRequestStateSchema,
  isDraft: Schema.Boolean,
  mergeStateStatus: PullRequestMergeStateSchema.pipe(
    Schema.catchDecoding(() => Effect.succeedSome("UNKNOWN" as const)),
    Schema.withDecodingDefault(Effect.succeed("UNKNOWN" as const)),
  ),
  // GitHub's record of an armed auto-merge, null when there is none.
  // It also carries who armed it and when, which nothing reads.
  autoMergeRequest: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ mergeMethod: Schema.optional(Schema.String) }),
    ),
  ),
  baseRefName: Schema.String,
  author: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
  ),
  updatedAt: Schema.String,
  additions: Schema.Natural,
  deletions: Schema.Natural,
  changedFiles: Schema.Natural,
  statusCheckRollup: Schema.Array(StatusCheckRollupItemSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
const decodeGhPrDetails = Schema.decodeUnknownResult(
  Schema.Array(GhPrDetailSchema),
);

const PASSED_CONCLUSIONS = new Set(["SUCCESS"]);
const NEUTRAL_CONCLUSIONS = new Set(["NEUTRAL"]);
const SKIPPED_CONCLUSIONS = new Set(["SKIPPED"]);
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "CANCELLED",
]);

function bucketForItem(item: StatusCheckRollupItem): PullRequestCheckBucket {
  // CheckRun: status describes lifecycle, conclusion the final verdict.
  // StatusContext: a single `state` covers both.
  const typename = item["__typename"];
  if (typename === "StatusContext" || item.state) {
    const state = item.state ?? "";
    if (state === "SUCCESS") return "passed";
    if (state === "FAILURE" || state === "ERROR") return "failing";
    return "pending";
  }
  if (item.status && item.status !== "COMPLETED") return "pending";
  const conclusion = item.conclusion ?? "";
  if (PASSED_CONCLUSIONS.has(conclusion)) return "passed";
  if (NEUTRAL_CONCLUSIONS.has(conclusion)) return "neutral";
  if (SKIPPED_CONCLUSIONS.has(conclusion)) return "skipped";
  if (FAILING_CONCLUSIONS.has(conclusion)) return "failing";
  // Empty / unrecognized conclusion on a COMPLETED check. Safest to
  // treat as pending so the user doesn't merge on an unknown signal.
  return "pending";
}

// detailsUrl/targetUrl are whatever the CI integration wrote: frequently
// an empty string (no details link), occasionally relative, and in the
// worst case a non-web scheme. PullRequestCheckSchema.url requires a real
// URL, and the renderer feeds it to openExternal, so only absolute
// http(s) links make the cut.
function toCheckUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

const isMergeMethod = Schema.is(MergeMethodSchema);

// GraphQL spells the armed method MERGE / SQUASH / REBASE. A spelling
// this build doesn't know reads as "not armed" rather than failing
// the whole PR.
function autoMergeMethod(
  request: { mergeMethod?: string } | null | undefined,
): MergeMethod | null {
  const method = request?.mergeMethod?.toLowerCase();
  return isMergeMethod(method) ? method : null;
}

// Single-branch lookup for the currently open worktree page. Uncached,
// since invalidations from focus / refs-changed must actually hit gh.
// The --head filter is server-side so this stays cheap regardless of
// repo PR count. Returns the rich detail shape (checks + mergeable
// state) since the only consumer is the worktree detail page. The slim
// PullRequest projection is used by the sidebar list path. Throws on
// transient gh / network / parse failure so callers can distinguish
// "no PR" (null) from "we don't know". The renderer uses that to
// avoid clobbering the sidebar's project-wide PR map.
export async function getWorktreePullRequest(
  cwd: string,
  branch: string,
): Promise<PullRequestDetail | null> {
  if (!(await ghReadyForRepo(cwd))) return null;
  const [detail, reviews] = await Promise.all([
    runGhPrListDetail(cwd, branch),
    fetchReviews(cwd, branch),
  ]);
  if (!detail) return null;
  const match = reviews?.find((pr) => pr.number === detail.number);
  return match ? { ...detail, reviews: toReviews(match) } : detail;
}

// The reviews come from GraphQL, beside the gh pr list call, for two
// fields gh pr list doesn't offer: latestOpinionatedReviews, which keeps
// an approval its reviewer later commented under (latestReviews has the
// comment instead), and review states without each review's body. On
// its own call so a failure (a team request needs read:org, which a
// token can lack) costs only the reviews chip, not the PR.
const REVIEWS_QUERY = `query($owner: String!, $repo: String!, $head: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $head, first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        author { login }
        reviewDecision
        latestOpinionatedReviews(first: 100) { nodes { author { login } state } }
        latestReviews(first: 100) { nodes { author { login } state } }
        reviewRequests(first: 100) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
              ... on Team { combinedSlug }
            }
          }
        }
      }
    }
  }
}`;

const GqlAuthorSchema = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const GqlReviewSchema = Schema.Struct({
  author: GqlAuthorSchema,
  state: Schema.String,
});

const GqlReviewsPullRequestSchema = Schema.Struct({
  number: PullRequestSchema.fields.number,
  author: GqlAuthorSchema,
  reviewDecision: Schema.NullOr(PullRequestReviewDecisionSchema).pipe(
    Schema.catchDecoding(() => Effect.succeedSome(null)),
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  latestOpinionatedReviews: Schema.Struct({
    nodes: Schema.Array(GqlReviewSchema),
  }),
  latestReviews: Schema.Struct({ nodes: Schema.Array(GqlReviewSchema) }),
  reviewRequests: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        requestedReviewer: Schema.NullOr(
          Schema.Struct({
            login: Schema.optional(Schema.String),
            combinedSlug: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
});
type GqlReviewsPullRequest = typeof GqlReviewsPullRequestSchema.Type;

const decodeGqlReviewsResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({
        pullRequests: Schema.Struct({
          nodes: Schema.Array(GqlReviewsPullRequestSchema),
        }),
      }),
    }),
  }),
);

// The branch's newest PRs with their reviews, or null on any failure:
// the PR shows without the reviews chip then.
async function fetchReviews(
  cwd: string,
  branch: string,
): Promise<readonly GqlReviewsPullRequest[] | null> {
  try {
    const { stdout } = await execGh(
      [
        "api",
        "graphql",
        "-F",
        "owner={owner}",
        "-F",
        "repo={repo}",
        "-f",
        `head=${branch}`,
        "-f",
        `query=${REVIEWS_QUERY}`,
      ],
      { cwd },
    );
    return decodeGqlReviewsResponse(JSON.parse(stdout)).pipe(
      Option.map((response) => response.data.repository.pullRequests.nodes),
      Option.getOrNull,
    );
  } catch {
    return null;
  }
}

const isReviewerState = Schema.is(PullRequestReviewerStateSchema);

// Each reviewer's opinion (an approval or a request for changes),
// else their comment, then whoever's asked and hasn't answered. The
// author's own reviews (replies in a thread are reviews too) are left
// out, and DISMISSED fails the state parse and drops.
function toReviews(pr: GqlReviewsPullRequest): PullRequestReviews {
  const author = pr.author?.login;
  const reviewers: PullRequestReviews["reviewers"][number][] = [];
  const seen = new Set<string>();
  for (const review of [
    ...pr.latestOpinionatedReviews.nodes,
    ...pr.latestReviews.nodes,
  ]) {
    const login = review.author?.login ?? "ghost";
    const { state } = review;
    if (
      login === author ||
      seen.has(login) ||
      state === "REQUESTED" ||
      !isReviewerState(state)
    )
      continue;
    seen.add(login);
    reviewers.push({ login, state });
  }
  for (const { requestedReviewer } of pr.reviewRequests.nodes) {
    const login = requestedReviewer?.login ?? requestedReviewer?.combinedSlug;
    if (login) reviewers.push({ login, state: "REQUESTED" });
  }
  return { decision: pr.reviewDecision, reviewers };
}

// Server-side filtering + minimal fields keeps this cheap even on
// huge-PR repos. Returns null when there's no PR for the branch;
// throws on gh / JSON / schema failure so the renderer can
// distinguish "no PR" from "couldn't load." Ten, so a newer fork's PR
// can't hide the branch's own (isKept).
async function runGhPrListDetail(
  cwd: string,
  branch: string,
): Promise<PullRequestDetail | null> {
  const [{ stdout }, checkedOut] = await Promise.all([
    execGh(
      [
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        branch,
        "--limit",
        "10",
        "--json",
        "number,url,title,body,state,isDraft,isCrossRepository,mergeStateStatus,autoMergeRequest,baseRefName,author,updatedAt,additions,deletions,changedFiles,statusCheckRollup",
      ],
      { cwd },
    ),
    checkedOutPullRequest(cwd, branch),
  ]);
  const parsed: unknown = JSON.parse(stdout);
  const validated = decodeGhPrDetails(parsed);
  if (Result.isFailure(validated)) {
    throw new Error(
      `Unexpected gh pr list output for ${branch}: ${validated.failure.message}`,
    );
  }
  const first = validated.success.find((pr) => isKept(pr, checkedOut));
  if (!first) return null;
  const checkList: PullRequestCheck[] = first.statusCheckRollup.map((item) => ({
    name: item.name ?? item.context ?? "check",
    bucket: bucketForItem(item),
    url: toCheckUrl(item.detailsUrl) ?? toCheckUrl(item.targetUrl),
  }));
  return {
    number: first.number,
    url: first.url,
    title: first.title,
    body: first.body,
    isCrossRepository: first.isCrossRepository,
    ...checkedOutMark(first),
    state: first.state,
    isDraft: first.isDraft,
    mergeState: first.mergeStateStatus,
    autoMerge: autoMergeMethod(first.autoMergeRequest),
    baseRefName: first.baseRefName,
    authorLogin: first.author?.login ?? "ghost",
    updatedAt: first.updatedAt,
    additions: first.additions,
    deletions: first.deletions,
    changedFiles: first.changedFiles,
    checks: summarizeChecks(checkList),
    checkList,
  };
}
