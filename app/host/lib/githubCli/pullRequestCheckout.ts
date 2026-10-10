// Checking out a pull request into a fresh worktree. Two halves: the
// picker's list of open PRs, and the resolver that turns the PR the user
// picked into a local branch. The resolver stops there on purpose. From
// the local branch, worktrees.create takes over through the ordinary
// `checkout` path, so the bundled CLI stays the create engine and knows
// nothing about PRs.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type PullRequestCandidate,
  type PullRequestCandidateList,
  type PullRequestCheckoutRef,
  PullRequestSchema,
} from "@shigomori/contracts/schemas";
import { forkBranchCandidates } from "@shigomori/contracts/git/branches";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { createLocalBranch } from "../git/branches";
import { run } from "../git/core";
import { localBranchExists } from "../git/remotes";
import { stderrOf } from "../util/processes";
import { gh, trimGhError } from "./exec";
import { GithubCli } from "./GithubCli";
import { remoteNameForUrl } from "./remote";

// Why a pull request can't be checked out, in words for the form.
class PullRequestCheckoutError extends Schema.TaggedError<PullRequestCheckoutError>()(
  "PullRequestCheckoutError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

const refused = (reason: string, cause?: unknown) =>
  new PullRequestCheckoutError({ reason, cause });

const git = (cwd: string, args: string[]) => run(cwd, args);

// Enough to fill a picker without paging. Deliberately below the
// sidebar sweep's 200: that one indexes every branch in the project,
// this one is a list a human scrolls.
const PR_CANDIDATE_LIMIT = 50;

// A gh user or owner, of which only the login is read.
const GhLoginSchema = Schema.optional(
  Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
);

const GhPrCandidateSchema = Schema.Struct({
  number: PullRequestSchema.fields.number,
  url: PullRequestSchema.fields.url,
  title: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.NonEmptyString,
  updatedAt: Schema.String,
  author: GhLoginSchema,
  isCrossRepository: Schema.Boolean,
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        nameWithOwner: Schema.optional(Schema.String),
      }),
    ),
  ),
  headRepositoryOwner: GhLoginSchema,
});
type GhPrCandidate = typeof GhPrCandidateSchema.Type;
const decodeGhPrCandidates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(GhPrCandidateSchema)),
);

// Derived from the schema that parses the response, so the two can't
// drift into "asked for a field we don't read" or the reverse.
const CANDIDATE_JSON_FIELDS = Object.keys(GhPrCandidateSchema.fields).join(",");

// Open PRs only: the mode exists to start a review, and checking out a
// merged or closed head is the "check out source" mode's job.
export const listPullRequestCandidates = Effect.fn("PullRequests.candidates")(
  function* (cwd: string) {
    const cli = yield* GithubCli;
    const unavailable = yield* cli.unavailableReason;
    if (unavailable) {
      return { status: "unavailable", reason: unavailable } as const;
    }
    if (!(yield* cli.repo(cwd))) {
      return { status: "unavailable", reason: "no-github-remote" } as const;
    }
    return yield* gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(PR_CANDIDATE_LIMIT),
        "--json",
        CANDIDATE_JSON_FIELDS,
      ],
      { cwd },
    ).pipe(
      Effect.flatMap(({ stdout }) => decodeGhPrCandidates(stdout)),
      // gh already returns newest-first, which is the order a reviewer
      // wants.
      Effect.map(
        (rows): PullRequestCandidateList => ({
          status: "ok",
          pullRequests: rows.map(toCandidate),
        }),
      ),
      // gh exited non-zero (network, SSO prompt, rate limit) or answered
      // with something we can't read. The form says so rather than
      // showing an empty list that reads as "no PRs".
      Effect.orElseSucceed(
        (): PullRequestCandidateList => ({
          status: "unavailable",
          reason: "gh-failed",
        }),
      ),
    );
  },
);

function toCandidate(row: GhPrCandidate): PullRequestCandidate {
  const owner = row.headRepositoryOwner?.login;
  const repo = row.headRepository?.name;
  // gh reports "owner/repo" directly on newer versions. When it's
  // missing, compose it from the two sibling fields.
  const nameWithOwner =
    row.headRepository?.nameWithOwner ??
    (owner && repo ? `${owner}/${repo}` : undefined);
  return {
    number: row.number,
    url: row.url,
    title: row.title,
    isDraft: row.isDraft,
    headRefName: row.headRefName,
    authorLogin: row.author?.login ?? "ghost",
    fromFork: row.isCrossRepository,
    headRepo: row.isCrossRepository ? (nameWithOwner ?? null) : null,
    updatedAt: row.updatedAt,
  };
}

const GhPrHeadSchema = Schema.Struct({
  // The repo half of this URL is the repo gh resolved the number
  // against, which is the one we have to fetch from.
  url: PullRequestSchema.fields.url,
  headRefName: Schema.NonEmptyString,
  isCrossRepository: Schema.Boolean,
  headRepositoryOwner: GhLoginSchema,
});
type GhPrHead = typeof GhPrHeadSchema.Type;
const decodeGhPrHead = Schema.decodeUnknownOption(
  Schema.fromJsonString(GhPrHeadSchema),
);

// Re-read the head from gh instead of trusting a number the renderer
// carried across the wire: the picker's list can be minutes stale, and
// fetching the wrong ref into a branch is not a mistake worth being
// relaxed about.
const readPullRequestHead = (cwd: string, number: number) =>
  gh(
    [
      "pr",
      "view",
      String(number),
      "--json",
      "url,headRefName,isCrossRepository,headRepositoryOwner",
    ],
    { cwd },
  ).pipe(
    Effect.catchTags({
      CommandError: (cause) =>
        Effect.fail(
          refused(
            `Couldn't read pull request #${number}: ${trimGhError(stderrOf(cause)) || "gh failed"}`,
            cause,
          ),
        ),
    }),
    Effect.flatMap(({ stdout }) =>
      Effect.fromOption(decodeGhPrHead(stdout)).pipe(
        Effect.mapError(() =>
          refused(`Unexpected gh pr view output for #${number}`),
        ),
      ),
    ),
  );

export const resolvePullRequestCheckout = Effect.fn(
  "PullRequests.resolveCheckout",
)(function* (cwd: string, number: number) {
  const cli = yield* GithubCli;
  if (yield* cli.unavailableReason) {
    return yield* refused("The GitHub CLI isn't available for this project.");
  }
  if (!(yield* cli.repo(cwd))) {
    return yield* refused("This project has no GitHub remote to fetch from.");
  }
  const head = yield* readPullRequestHead(cwd, number);
  // Resolved from the PR's URL rather than from "the first GitHub
  // remote": in a fork checkout both the fork and the parent are
  // remotes, and gh answered from the parent.
  const remote = yield* remoteNameForUrl(cwd, head.url);
  if (!remote) {
    return yield* refused(
      `No git remote points at the repository holding pull request ` +
        `#${number} (${head.url}). Add one and try again.`,
    );
  }
  return head.isCrossRepository
    ? yield* resolveForkHead(cwd, remote, number, head)
    : yield* resolveSameRepoHead(cwd, remote, head.headRefName);
});

// Same-repo head: an ordinary remote branch. Land it on a local branch
// tracking the remote, which is what the user would have gotten by
// checking the branch out by hand. Push, pull, and the worktree page's
// ahead/behind all behave normally from there.
const resolveSameRepoHead = Effect.fnUntraced(function* (
  cwd: string,
  remote: string,
  branch: string,
) {
  // Both fetch forms below opportunistically refresh
  // refs/remotes/<remote>/<branch> as a side effect, so neither path
  // needs a second round trip to leave the tracking ref current.
  if (yield* localBranchExists(cwd, branch)) {
    // The <src>:<dst> refspec is fast-forward-only, so a local branch
    // that has drifted from the PR head errors out instead of quietly
    // checking out stale code. (git also refuses when the branch is
    // checked out elsewhere, which the form greys those PRs out for.)
    yield* git(cwd, ["fetch", "--quiet", remote, `${branch}:${branch}`]).pipe(
      Effect.mapError((err) =>
        refused(
          `Local branch ${branch} can't be fast-forwarded to the pull ` +
            `request head. Delete or rename it and try again. (${message(err)})`,
          err,
        ),
      ),
    );
  } else {
    yield* git(cwd, ["fetch", "--quiet", remote, branch]);
    // Explicit rather than leaning on `git worktree add`'s DWIM, which
    // only fires when exactly one remote has the branch. createLocalBranch
    // sets --track for a remote-tracking base, which is what this is.
    yield* createLocalBranch(cwd, branch, `${remote}/${branch}`);
  }
  return { branch } satisfies PullRequestCheckoutRef;
});

// Fork head: not on any remote we track, but GitHub publishes it on the
// base repo as refs/pull/<n>/head. Same ref `gh pr checkout` uses.
const resolveForkHead = Effect.fnUntraced(function* (
  cwd: string,
  remote: string,
  number: number,
  head: GhPrHead,
) {
  const pullRef = `refs/pull/${number}/head`;
  const branch = yield* pickForkBranchName(cwd, number, head);
  // Unforced refspec: an existing branch that has diverged from the PR
  // head fails rather than discarding whatever was on it. Non-fast-
  // forward (the author force-pushed since this branch was last checked
  // out) and "checked out at <path>" (the PR is already open in another
  // worktree) both land here, and git's own stderr says which, and the
  // remedy is the same either way.
  yield* git(cwd, [
    "fetch",
    "--quiet",
    remote,
    `${pullRef}:refs/heads/${branch}`,
  ]).pipe(
    Effect.mapError((err) =>
      refused(
        `Couldn't fetch ${pullRef} onto ${branch}: ${message(err)}. Delete ` +
          `or rename ${branch} and try again.`,
        err,
      ),
    ),
  );
  // What `gh pr checkout` writes for a fork the user can't push to:
  // `git pull` re-fetches the PR head, and nothing is configured to push
  // at a branch that isn't theirs. It also leaves @{upstream}
  // unresolvable, so the worktree page shows the branch as unpublished,
  // which is true.
  yield* git(cwd, ["config", `branch.${branch}.remote`, remote]);
  yield* git(cwd, ["config", `branch.${branch}.merge`, pullRef]);
  return { branch } satisfies PullRequestCheckoutRef;
});

// Reuse a branch when it's one we created for this same PR, otherwise
// take the next candidate name rather than fetching over whatever the
// user had there. The candidate list is shared with the form so the two
// agree on which PRs are already checked out.
const pickForkBranchName = Effect.fnUntraced(function* (
  cwd: string,
  number: number,
  head: GhPrHead,
) {
  const pullRef = `refs/pull/${number}/head`;
  const candidates = forkBranchCandidates(
    number,
    head.headRefName,
    head.headRepositoryOwner?.login,
  );
  // The first usable name wins, so the rest aren't probed up front.
  for (const name of candidates) {
    if (!(yield* localBranchExists(cwd, name))) return name;
    if ((yield* readBranchMerge(cwd, name)) === pullRef) return name;
  }
  return yield* refused(
    `Branches ${candidates.join(" and ")} both already exist and neither ` +
      `tracks pull request #${number}. Delete or rename one and try again.`,
  );
});

// The fork's PR a branch was checked out from, by number: what
// resolveForkHead (and `gh pr checkout`) points branch.<b>.merge at.
// That PR is the branch's own though it comes from a fork. Null for
// any other branch.
export const checkedOutPullRequest = (cwd: string, branch: string) =>
  Effect.map(readBranchMerge(cwd, branch), pullRequestOfMergeRef);

// The same for every branch of the repo at once, in one git call:
// branch to the number of the fork PR it was checked out from.
export const checkedOutPullRequests = Effect.fnUntraced(function* (
  cwd: string,
) {
  const numbers = new Map<string, number>();
  const listed = yield* Effect.result(
    git(cwd, ["config", "--get-regexp", String.raw`^branch\..*\.merge$`]),
  );
  // Exit 1: no branch has a merge ref.
  if (Result.isFailure(listed)) return numbers;
  for (const line of listed.success.split("\n")) {
    const [key = "", ref = null] = line.split(" ");
    const branch = key.match(/^branch\.(.+)\.merge$/)?.[1];
    const number = pullRequestOfMergeRef(ref);
    if (branch && number !== null) numbers.set(branch, number);
  }
  return numbers;
});

function pullRequestOfMergeRef(ref: string | null): number | null {
  const match = ref?.trim().match(/^refs\/pull\/(\d+)\/head$/);
  return match?.[1] ? Number(match[1]) : null;
}

const readBranchMerge = (cwd: string, branch: string) =>
  git(cwd, ["config", "--get", `branch.${branch}.merge`]).pipe(
    Effect.map((stdout) => stdout.trim() || null),
    // Exit 1 just means the key isn't set.
    Effect.orElseSucceed(() => null),
  );

// A git failure's message is its stderr (git/core.ts), of which the last
// line is the useful part.
function message(err: unknown): string {
  return trimGhError(errorMessageOf(err));
}
