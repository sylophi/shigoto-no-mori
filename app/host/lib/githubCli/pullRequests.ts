import { checkBucket } from "@shigomori/contracts/pullRequestChecks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  isFromThisRepository,
  matchesMapEntry,
  type MergeMethod,
  MergeMethodSchema,
  type PullRequest,
  type PullRequestCheck,
  type PullRequestDetail,
  PullRequestMergeStateSchema,
  PullRequestReviewDecisionSchema,
  PullRequestReviewerStateSchema,
  type PullRequestReviews,
  PullRequestSchema,
  PullRequestStateSchema,
  pullRequestsEqual,
  summarizeChecks,
  toSlimPullRequest,
} from "@shigomori/contracts/schemas";
import { gh } from "./exec";
import {
  checkedOutPullRequest,
  checkedOutPullRequests,
} from "./pullRequestCheckout";
import { GithubCli } from "./GithubCli";

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
  Schema.fromJsonString(Schema.Array(GhPrListItemSchema)),
);

const PR_CACHE_TTL_MS = 5 * 60_000;
const PR_LIST_LIMIT = 200;
const prCache = new Map<
  string,
  { value: Map<string, PullRequest>; expires: number }
>();

// Runs `gh pr list ...` with the standard JSON projection. Returns the
// parsed rows on success or null on any failure (gh exit, JSON, schema).
const runGhPrList = (cwd: string) =>
  gh(
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
  ).pipe(
    Effect.map(({ stdout }) => Option.getOrNull(decodeGhPrList(stdout))),
    Effect.orElseSucceed((): readonly GhPrListItem[] | null => null),
  );

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
// sweep in BackgroundFetch.ts. This read path just serves whatever's there.
// Toggle + readiness checks gate the cache too, so flipping the
// integration off takes effect immediately.
export const listProjectPullRequests = Effect.fn("PullRequests.list")(
  function* (cwd: string) {
    if (!(yield* (yield* GithubCli).readyForRepo(cwd))) {
      return new Map<string, PullRequest>();
    }
    const cached = prCache.get(cwd);
    if (cached && cached.expires > (yield* Clock.currentTimeMillis)) {
      return cached.value;
    }
    return yield* refreshProjectPullRequests(cwd);
  },
);

// Bypass the cache and repopulate. Used by the background sweep.
export const refreshProjectPullRequests = Effect.fn("PullRequests.refresh")(
  function* (cwd: string) {
    if (!(yield* (yield* GithubCli).readyForRepo(cwd))) {
      return cacheAndReturn(cwd, new Map());
    }
    const [rows, checkedOut] = yield* Effect.all(
      [runGhPrList(cwd), checkedOutPullRequests(cwd)],
      { concurrency: 2 },
    );
    if (rows === null) {
      // Transient gh / network failure. Preserve the previous map so the
      // sidebar dots don't blink out on a single bad sweep. Fall through
      // to caching empty only when we've never had a value.
      const previous = prCache.get(cwd)?.value;
      return previous ?? cacheAndReturn(cwd, new Map());
    }
    // gh returns PRs newest-first; first hit per branch wins so we
    // surface the freshest PR when a branch has been reused, of those
    // isKept.
    const map = new Map<string, PullRequest>();
    for (const item of rows) {
      if (map.has(item.headRefName)) continue;
      if (!isKept(item, checkedOut.get(item.headRefName))) continue;
      map.set(item.headRefName, toPullRequest(item));
    }
    return cacheAndReturn(cwd, map);
  },
);

export function readCachedProjectPullRequests(
  cwd: string,
): Map<string, PullRequest> | null {
  return prCache.get(cwd)?.value ?? null;
}

// What a page's own read of one branch's PR learned, written into the
// project's map (the sweep's) so its view moves as soon as the page
// does: true when the map changed.
export function noteBranchPullRequest(
  cwd: string,
  branch: string,
  pr: PullRequestDetail | null,
): boolean {
  const cached = prCache.get(cwd);
  if (!cached || matchesMapEntry(pr, cached.value.get(branch))) return false;
  const value = new Map(cached.value);
  if (pr === null) value.delete(branch);
  else value.set(branch, toSlimPullRequest(pr));
  prCache.set(cwd, { value, expires: cached.expires });
  return true;
}

// A PR's title as `sm describe` just set it, written into the project's
// map so its view shows it before the next sweep: true when it did.
export function retitleBranchPullRequest(
  cwd: string,
  branch: string,
  title: string,
): boolean {
  const cached = prCache.get(cwd);
  const pr = cached?.value.get(branch);
  if (!cached || !pr || pr.title === title) return false;
  const value = new Map(cached.value).set(branch, { ...pr, title });
  prCache.set(cwd, { value, expires: cached.expires });
  return true;
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
const decodeGhPrDetails = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(GhPrDetailSchema)),
);

// gh answered a branch's pull requests in a shape this build can't read.
class PullRequestShapeError extends Schema.TaggedError<PullRequestShapeError>()(
  "PullRequestShapeError",
  { branch: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Unexpected gh pr list output for ${this.branch}`;
  }
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
// "no PR" (null) from "we don't know", and asks gh whether or not the
// repo is ready (the caller checks), so its null is GitHub's answer.
export const getWorktreePullRequest = Effect.fn("PullRequests.forBranch")(
  function* (cwd: string, branch: string) {
    const [detail, extras] = yield* Effect.all(
      [runGhPrListDetail(cwd, branch), fetchGraphqlExtras(cwd, branch)],
      { concurrency: 2 },
    );
    if (!detail) return null;
    const match = extras?.find((pr) => pr.number === detail.number);
    if (!match) return detail;
    return {
      ...detail,
      body: detail.body && withSignedImages(detail.body, match.bodyHTML),
      bodySource: detail.body,
      reviews: toReviews(match),
    } satisfies PullRequestDetail;
  },
);

// The reviews come from GraphQL, beside the gh pr list call, for two
// fields gh pr list doesn't offer: latestOpinionatedReviews, which keeps
// an approval its reviewer later commented under (latestReviews has the
// comment instead), and review states without each review's body. So
// does the body as GitHub renders it, for its images' signed URLs
// (withSignedImages). On its own call so a failure (a team request
// needs read:org, which a token can lack) costs only the reviews chip
// and the private images, not the PR.
const EXTRAS_QUERY = `query($owner: String!, $repo: String!, $head: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $head, first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        bodyHTML
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

const GqlExtrasPullRequestSchema = Schema.Struct({
  number: PullRequestSchema.fields.number,
  bodyHTML: Schema.String.pipe(
    Schema.catchDecoding(() => Effect.succeedSome("")),
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
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
type GqlExtrasPullRequest = typeof GqlExtrasPullRequestSchema.Type;

const decodeGqlExtrasResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequests: Schema.Struct({
            nodes: Schema.Array(GqlExtrasPullRequestSchema),
          }),
        }),
      }),
    }),
  ),
);

// The branch's newest PRs with their reviews and rendered bodies, or
// null on any failure: the PR shows without the reviews chip then.
const fetchGraphqlExtras = (cwd: string, branch: string) =>
  gh(
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
      `query=${EXTRAS_QUERY}`,
    ],
    { cwd },
  ).pipe(
    Effect.map(({ stdout }) =>
      decodeGqlExtrasResponse(stdout).pipe(
        Option.map((response) => response.data.repository.pullRequests.nodes),
        Option.getOrNull,
      ),
    ),
    Effect.orElseSucceed((): readonly GqlExtrasPullRequest[] | null => null),
  );

const isReviewerState = Schema.is(PullRequestReviewerStateSchema);

// Each reviewer's opinion (an approval or a request for changes),
// else their comment, then whoever's asked and hasn't answered. The
// author's own reviews (replies in a thread are reviews too) are left
// out, and DISMISSED fails the state parse and drops.
function toReviews(pr: GqlExtrasPullRequest): PullRequestReviews {
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

// An attachment (<host>/user-attachments/assets/<id>, or the older
// <host>/<owner>/<repo>/assets/<n>/<id>, on github.com, a GitHub
// Enterprise Server or GHE.com) in a private repo, or anywhere on an
// Enterprise Server in private mode, loads only for a browser signed in
// to that host, which the app's windows aren't, so the markdown body's
// images stay blank. The body GitHub renders points each at a URL anyone
// can load (signed for a few minutes where it is signed), on the
// attachment's host, a subdomain of it or githubusercontent.com, with
// the attachment's id in it, and an
// image in the markdown (![](…) or src=…) takes its attachment's. A link
// stays as written, for the browser it opens in. A signed URL is reused
// while it has a minute left, so a refetch leaves the body as it was and
// its images don't load again.
const SIGNED_URL_REUSE_MS = 4 * 60_000;
const signedUrls = new Map<string, { url: string; until: number }>();
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_PATH = `/(?:user-attachments/assets|[\\w.-]+/[\\w.-]+/assets/\\d+)/(${UUID})`;
// The attachment's authority, with an Enterprise Server's port if its
// URL names one.
const ATTACHED_IMAGE = new RegExp(
  `(!\\[[^\\]]*\\]\\(\\s*<?|\\bsrc\\s*=\\s*["']?)https://([a-z0-9.-]+(?::\\d+)?)${ATTACHMENT_PATH}`,
  "gi",
);
const RENDERED_IMAGE = /<img\b[^>]*?\bsrc="(https:\/\/[^"]+)"/g;
const ID = new RegExp(UUID, "i");
const IS_ATTACHMENT = new RegExp(`^${ATTACHMENT_PATH}$`, "i");

// Exported for the pull-request-images proof.
export function withSignedImages(body: string, bodyHTML: string): string {
  const now = Date.now();
  for (const [key, signed] of signedUrls) {
    if (signed.until <= now) signedUrls.delete(key);
  }
  const hostOf = new Map<string, string>();
  for (const [, , host = "", id = ""] of body.matchAll(ATTACHED_IMAGE)) {
    hostOf.set(id.toLowerCase(), host.toLowerCase());
  }
  for (const [, html = ""] of bodyHTML.matchAll(RENDERED_IMAGE)) {
    const rendered = html.replaceAll("&amp;", "&");
    let url: URL;
    try {
      url = new URL(rendered);
    } catch {
      continue;
    }
    const id = ID.exec(url.pathname)?.[0]?.toLowerCase();
    const host = id === undefined ? undefined : hostOf.get(id);
    if (id === undefined || host === undefined) continue;
    const hostname = host.replace(/:\d+$/, "");
    const loadable =
      url.host === host.replace(/:443$/, "")
        ? !IS_ATTACHMENT.test(url.pathname)
        : url.hostname.endsWith(`.${hostname}`) ||
          url.hostname.endsWith(".githubusercontent.com");
    const key = `${host}/${id}`;
    if (loadable && !signedUrls.has(key)) {
      signedUrls.set(key, { url: rendered, until: now + SIGNED_URL_REUSE_MS });
    }
  }
  return body.replace(
    ATTACHED_IMAGE,
    (whole, lead: string, host: string, id: string) => {
      const key = `${host.toLowerCase()}/${id.toLowerCase()}`;
      const signed = signedUrls.get(key);
      return signed ? lead + signed.url : whole;
    },
  );
}

// Server-side filtering + minimal fields keeps this cheap even on
// huge-PR repos. Returns null when there's no PR for the branch;
// throws on gh / JSON / schema failure so the renderer can
// distinguish "no PR" from "couldn't load." Ten, so a newer fork's PR
// can't hide the branch's own (isKept).
const runGhPrListDetail = Effect.fnUntraced(function* (
  cwd: string,
  branch: string,
) {
  const [{ stdout }, checkedOut] = yield* Effect.all(
    [
      gh(
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
    ],
    { concurrency: 2 },
  );
  const validated = yield* decodeGhPrDetails(stdout).pipe(
    Effect.mapError((cause) => new PullRequestShapeError({ branch, cause })),
  );
  const first = validated.find((pr) => isKept(pr, checkedOut));
  if (!first) return null;
  const checkList: PullRequestCheck[] = first.statusCheckRollup.map((item) => ({
    name: item.name ?? item.context ?? "check",
    bucket: checkBucket(item),
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
  } satisfies PullRequestDetail;
});
