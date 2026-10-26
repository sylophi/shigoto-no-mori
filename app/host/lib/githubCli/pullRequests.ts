import { checkBucket } from "@shigomori/contracts/pullRequestChecks";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  isBranchsOwn,
  isFromThisRepository,
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
} from "@shigomori/contracts/schemas";
import * as GitHub from "@shigomori/engine/GitHub";
import { ageOf, type Stamp } from "../util/kept";
import { gh } from "./exec";
import {
  checkedOutPullRequest,
  checkedOutPullRequests,
} from "./pullRequestCheckout";

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

// Every open PR, and the newest of all states for the merged and closed
// ones: a busy repo's open PRs fall out of its newest 200.
const OPEN_PR_LIMIT = 1000;
const RECENT_PR_LIMIT = 200;

const runGhPrList = (cwd: string, state: "open" | "all", limit: number) =>
  gh(
    [
      "pr",
      "list",
      "--state",
      state,
      "--limit",
      String(limit),
      "--json",
      "number,url,title,state,isDraft,headRefName,baseRefName,isCrossRepository",
    ],
    { cwd },
  ).pipe(
    Effect.map(({ stdout }) => Option.getOrNull(decodeGhPrList(stdout))),
    Effect.orElseSucceed((): readonly GhPrListItem[] | null => null),
  );

function toPullRequest(item: GhPrListItem, stack?: number): PullRequest {
  return {
    number: item.number,
    url: item.url,
    title: item.title,
    state: item.state,
    isDraft: item.isDraft,
    baseRefName: item.baseRefName,
    isCrossRepository: item.isCrossRepository,
    ...(stack === undefined ? {} : { stack }),
    ...checkedOutMark(item),
  };
}

// Kept fork PRs are always checked-out ones, marked so the renderer
// keeps them too (isBranchsPullRequest).
function checkedOutMark(pr: {
  isCrossRepository: boolean;
}): Pick<PullRequest, "checkedOutFrom"> {
  return isFromThisRepository(pr) ? {} : { checkedOutFrom: true };
}

// The project's PRs by head branch, or null when gh failed (the
// network, its output). Newest first, so a reused branch keeps its
// newest own PR.
export const readProjectPullRequests = Effect.fnUntraced(function* (
  cwd: string,
) {
  const [open, recent, stackOf, checkedOut] = yield* Effect.all(
    [
      runGhPrList(cwd, "open", OPEN_PR_LIMIT),
      runGhPrList(cwd, "all", RECENT_PR_LIMIT),
      Effect.flatMap(GitHub.GitHub, (github) => github.stacks(cwd)).pipe(
        Effect.orElseSucceed(() => null),
      ),
      checkedOutPullRequests(cwd),
    ],
    { concurrency: 4 },
  );
  if (open === null || recent === null || stackOf === null) return null;
  const byNumber = new Map(
    [...open, ...recent].map((item) => [item.number, item]),
  );
  const rows = [...byNumber.values()].toSorted((a, b) => b.number - a.number);
  const map = new Map<string, PullRequest>();
  for (const item of rows) {
    if (map.has(item.headRefName)) continue;
    if (!isBranchsOwn(item, checkedOut.get(item.headRefName))) continue;
    map.set(item.headRefName, toPullRequest(item, stackOf.get(item.number)));
  }
  return map;
});

export function pullRequestMapsEqual(
  a: ReadonlyMap<string, PullRequest>,
  b: ReadonlyMap<string, PullRequest>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [branch, pa] of a) {
    const pb = b.get(branch);
    if (!pb || !pullRequestsEqual(pa, pb)) return false;
  }
  return true;
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

// One branch's PR with its checks and merge state, for the worktree
// page, read through gh's server-side --head filter so it stays cheap in
// a repo of many PRs. Null is GitHub's "no PR": a gh, network or output
// failure fails, and the caller has checked the repo is ready. `sign`
// points the body's images at the rendered body's URLs
// (withSignedImages).
export const readBranchPullRequest = Effect.fnUntraced(function* (
  cwd: string,
  branch: string,
  sign: (body: string, bodyHTML: string) => Effect.Effect<string>,
) {
  const [detail, extras] = yield* Effect.all(
    [runGhPrListDetail(cwd, branch), fetchGraphqlExtras(cwd, branch)],
    { concurrency: 2 },
  );
  if (!detail) return null;
  const match = extras?.find((pr) => pr.number === detail.number);
  if (!match) return detail;
  return {
    ...detail,
    body: detail.body && (yield* sign(detail.body, match.bodyHTML)),
    bodySource: detail.body,
    reviews: toReviews(match),
  } satisfies PullRequestDetail;
});

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
// for a few minutes, so a refetch leaves the body as it was and its
// images don't load again, but never within a minute of the expiry its
// token names.
const SIGNED_URL_REUSE_MS = 4 * 60_000;
const SIGNED_URL_MARGIN_MS = 60_000;

// By attachment (host/id): the URL, when it was signed, and its token's
// expiry on the wall clock, null when it names none (an Enterprise
// Server's media host signs with an opaque token).
export type SignedUrls = Map<
  string,
  {
    readonly url: string;
    readonly at: Stamp;
    readonly expires: number | null;
  }
>;
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

const decodeTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite })),
);

// The wall-clock expiry a URL's `jwt` names (its `exp` claim, in
// seconds), or null.
function tokenExpiry(url: URL): number | null {
  const payload = url.searchParams.get("jwt")?.split(".")[1];
  if (payload === undefined) return null;
  const json = Base64Url.decodeString(payload);
  if (Result.isFailure(json)) return null;
  return Option.match(decodeTokenClaims(json.success), {
    onNone: () => null,
    onSome: ({ exp }) => exp * 1000,
  });
}

export function withSignedImages(
  body: string,
  bodyHTML: string,
  signedUrls: SignedUrls,
  now: Stamp,
): string {
  for (const [key, signed] of signedUrls) {
    if (
      ageOf(signed.at, now) >= SIGNED_URL_REUSE_MS ||
      (signed.expires !== null &&
        signed.expires - SIGNED_URL_MARGIN_MS <= now.wall)
    ) {
      signedUrls.delete(key);
    }
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
      signedUrls.set(key, {
        url: rendered,
        at: now,
        expires: tokenExpiry(url),
      });
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

// Ten, so a newer fork's PR of the same name can't hide the branch's
// own (isBranchsOwn).
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
  const first = validated.find((pr) => isBranchsOwn(pr, checkedOut));
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
