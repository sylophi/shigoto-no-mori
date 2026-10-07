import { z } from "zod";
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
  PullRequestStateSchema,
  pullRequestsEqual,
  summarizeChecks,
} from "@shared/schemas";
import { execGh } from "./exec";
import {
  checkedOutPullRequest,
  checkedOutPullRequests,
} from "./pullRequestCheckout";
import { ghReadyForRepo } from "./remote";

const GhPrListItemSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  isCrossRepository: z.boolean().default(false),
});
type GhPrListItem = z.infer<typeof GhPrListItemSchema>;

const PR_CACHE_TTL_MS = 5 * 60_000;
const PR_LIST_LIMIT = 200;
const prCache = new Map<
  string,
  { value: Map<string, PullRequest>; expires: number }
>();

// Runs `gh pr list ...` with the standard JSON projection. Returns the
// parsed rows on success or null on any failure (gh exit, JSON, schema).
async function runGhPrList(cwd: string): Promise<GhPrListItem[] | null> {
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
    const validated = z.array(GhPrListItemSchema).safeParse(parsed);
    return validated.success ? validated.data : null;
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
// schema permissive (loose object + every field optional) because gh
// occasionally inlines extra typenames and we'd rather degrade
// gracefully than reject the whole list.
const StatusCheckRollupItemSchema = z.looseObject({
  __typename: z.string().optional(),
  name: z.string().optional(),
  context: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  state: z.string().optional(),
  detailsUrl: z.string().optional(),
  targetUrl: z.string().optional(),
});
type StatusCheckRollupItem = z.infer<typeof StatusCheckRollupItemSchema>;

const GhPrDetailSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  body: z.string().default(""),
  isCrossRepository: z.boolean().default(false),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
  mergeStateStatus: PullRequestMergeStateSchema.catch("UNKNOWN"),
  // GitHub's record of an armed auto-merge, null when there is none.
  // Loose: it also carries who armed it and when, which nothing reads.
  autoMergeRequest: z
    .looseObject({ mergeMethod: z.string().optional() })
    .nullish(),
  baseRefName: z.string(),
  author: z.looseObject({ login: z.string().optional() }).nullish(),
  updatedAt: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  statusCheckRollup: z.array(StatusCheckRollupItemSchema).default([]),
});

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

// GraphQL spells the armed method MERGE / SQUASH / REBASE. A spelling
// this build doesn't know reads as "not armed" rather than failing
// the whole PR.
function autoMergeMethod(
  request: { mergeMethod?: string } | null | undefined,
): MergeMethod | null {
  const parsed = MergeMethodSchema.safeParse(
    request?.mergeMethod?.toLowerCase(),
  );
  return parsed.success ? parsed.data : null;
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

const GqlReviewSchema = z.object({
  author: z.object({ login: z.string() }).nullable(),
  state: z.string(),
});

const GqlReviewsPullRequestSchema = z.object({
  number: z.number().int().positive(),
  author: z.object({ login: z.string() }).nullable(),
  reviewDecision: PullRequestReviewDecisionSchema.nullable().catch(null),
  latestOpinionatedReviews: z.object({ nodes: z.array(GqlReviewSchema) }),
  latestReviews: z.object({ nodes: z.array(GqlReviewSchema) }),
  reviewRequests: z.object({
    nodes: z.array(
      z.object({
        requestedReviewer: z
          .object({
            login: z.string().optional(),
            combinedSlug: z.string().optional(),
          })
          .nullable(),
      }),
    ),
  }),
});
type GqlReviewsPullRequest = z.infer<typeof GqlReviewsPullRequestSchema>;

const GqlReviewsResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({ nodes: z.array(GqlReviewsPullRequestSchema) }),
    }),
  }),
});

// The branch's newest PRs with their reviews, or null on any failure:
// the PR shows without the reviews chip then.
async function fetchReviews(
  cwd: string,
  branch: string,
): Promise<GqlReviewsPullRequest[] | null> {
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
    const parsed = GqlReviewsResponseSchema.safeParse(JSON.parse(stdout));
    return parsed.success
      ? parsed.data.data.repository.pullRequests.nodes
      : null;
  } catch {
    return null;
  }
}

const SUBMITTED_REVIEW_STATE = PullRequestReviewerStateSchema.exclude([
  "REQUESTED",
]);

// Each reviewer's opinion (an approval or a request for changes),
// else their comment, then whoever's asked and hasn't answered. The
// author's own reviews (replies in a thread are reviews too) are left
// out, and DISMISSED fails the state parse and drops.
function toReviews(pr: GqlReviewsPullRequest): PullRequestReviews {
  const author = pr.author?.login;
  const reviewers: PullRequestReviews["reviewers"] = [];
  const seen = new Set<string>();
  for (const review of [
    ...pr.latestOpinionatedReviews.nodes,
    ...pr.latestReviews.nodes,
  ]) {
    const login = review.author?.login ?? "ghost";
    const state = SUBMITTED_REVIEW_STATE.safeParse(review.state);
    if (login === author || seen.has(login) || !state.success) continue;
    seen.add(login);
    reviewers.push({ login, state: state.data });
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
  const validated = z.array(GhPrDetailSchema).safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Unexpected gh pr list output for ${branch}: ${validated.error.message}`,
    );
  }
  const first = validated.data.find((pr) => isKept(pr, checkedOut));
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
