// What the engine and the host ask GitHub, through the user's own `gh`:
// the pull requests a branch and a repository have. One runner under
// every lookup, so the install check, the deadline and the reasons a
// lookup couldn't be made are the same for each.
import {
  mergeSettingsOf,
  type MergeSettings,
} from "@shigomori/contracts/mergeMethods";
import {
  isBranchsOwn,
  type MergeMethod,
  type RepoMergeConfig,
} from "@shigomori/contracts/schemas/pullRequest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { elapsedMillis } from "./elapsed.ts";
import { envVar } from "./environment.ts";
import { ghHostFor, ghKnownHosts } from "./ghHost.ts";
import * as Git from "./Git.ts";
import * as GoJson from "./goJson.ts";
import {
  DETAIL_FIELDS,
  detailRowsOf,
  lookupArgs,
  ownByBranch,
  ownOf,
  type PullRequestCard,
  type PullRequestRow,
  type PullRequestSummary,
  rollupChecks,
  rowOf,
  rowsOf,
  SUMMARY_FIELDS,
  summaryOf,
} from "./github/rows.ts";
import {
  MERGE_PROGRESS_QUERY,
  type MergeProgress,
  parseMergeProgress,
} from "./mergeProgress.ts";
import * as Paths from "./Paths.ts";
import * as Processes from "./processes.ts";

// A gh that couldn't answer, sorted where it failed: not installed, not
// signed in, no remote on a GitHub host it knows, any other failure, or
// past the caller's deadline. The command's failure is the cause
// (stderrOf, stdoutOf).
export class GitHubCliError extends Schema.TaggedError<GitHubCliError>()(
  "GitHubCliError",
  {
    reason: Schema.Literals([
      "missing",
      "unauthenticated",
      "no-github-remote",
      "failed",
      "timeout",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return reasonOf(this);
  }
}

export type {
  PullRequestCard,
  PullRequestRow,
  PullRequestSummary,
} from "./github/rows.ts";

// The open pull request that holds a worktree's title and description.
// `isCrossRepository` is always false, and printed: the `--json`
// document keeps it.
export type OwningPullRequest = {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly isCrossRepository: boolean;
};

// gh answered with something this build can't read.
export class GitHubOutputError extends Schema.TaggedError<GitHubOutputError>()(
  "GitHubOutputError",
  { command: Schema.String },
) {
  override get message(): string {
    return `unexpected gh ${this.command} output`;
  }
}

const isOutputError = Schema.is(GitHubOutputError);

// A stack GitHub knows, bottom first. A merged PR is "closed".
export type GitHubStack = ReadonlyArray<{
  readonly number: number;
  readonly state: string;
}>;

// How GitHub's own stack merge ended.
export type AsyncMergeOutcome = "merged" | "enqueued";

export class StackMergeFailed extends Schema.TaggedError<StackMergeFailed>()(
  "StackMergeFailed",
  {
    number: Schema.Int,
    reason: Schema.Literals(["timeout", "refused"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "timeout"
      ? `GitHub is still merging the stack. Check PR #${this.number}`
      : `GitHub didn't merge the stack: ${this.detail}`;
  }
}

// A lookup's answer: what it found (null for nothing), or why it
// couldn't look.
export type Lookup<A> = {
  readonly found: A | null;
  readonly unavailable?: string;
};

// The owning pull request's lookup. A gh that isn't signed in can't
// show the PR anywhere, so that failure is certain there is none to
// mind. One that timed out or errored may have missed it.
export type OwningLookup = Lookup<OwningPullRequest> & {
  readonly uncertain?: true;
};

// A gh run's deadline, DEFAULT_TIMEOUT when none is given.
type RunOptions = { readonly timeout?: Duration.Input | undefined };

type DecodeRows = (
  stdout: string,
) => Option.Option<ReadonlyArray<PullRequestRow>>;

// A run's options, and the decoder for a read that needs more of its rows
// than the summary's.
type RowsOptions = RunOptions & { readonly decode?: DecodeRows };

// One `gh pr list` of the repo's newest PRs.
type ListPage = {
  readonly state: "all" | "open" | "closed";
  readonly limit: number;
};

export class GitHub extends Context.Service<
  GitHub,
  {
    // gh with `args` in `cwd`, pinned to its GitHub host (hostOf).
    readonly run: (
      cwd: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<string, GitHubCliError>;
    // gh with `args` outside any repo, pinned to `host` when one is
    // given (gh's own default host otherwise).
    readonly runOn: (
      host: string | null,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<string, GitHubCliError>;
    // The GitHub host of the remote gh resolves `cwd`'s repo from, or
    // null for none. Every gh run in a repo goes there: `gh api` asks
    // github.com otherwise.
    readonly hostOf: (cwd: string) => Effect.Effect<string | null>;
    // The hosts gh is signed in to, as its hosts.yml lists them, and
    // github.com always. A file that is there and can't be read fails.
    readonly knownHosts: Effect.Effect<
      ReadonlySet<string>,
      PlatformError.PlatformError
    >;
    // The branch's pull request with its checks, as the status card
    // shows it: the newest that is the branch's own.
    readonly cardFor: (
      repo: string,
      branch: string,
    ) => Effect.Effect<Lookup<PullRequestCard>>;
    // The open pull request from this repository on the branch, which
    // owns the worktree's title and description. `uncertain` when the
    // lookup failed in a way that could have missed one.
    readonly owningPullRequest: (
      repo: string,
      branch: string,
    ) => Effect.Effect<OwningLookup>;
    // The branch's own pull request, any state, as its page shows it.
    readonly detailFor: (
      repo: string,
      branch: string,
      options?: RunOptions,
    ) => Effect.Effect<
      Option.Option<PullRequestRow>,
      GitHubCliError | GitHubOutputError
    >;
    // The branch's pull request, any state, newest first: the first that
    // isn't a fork's, or is the one the branch was checked out from.
    // `extraFields` are asked for beside the summary.
    readonly find: (
      repo: string,
      branch: string,
      extraFields?: ReadonlyArray<string>,
    ) => Effect.Effect<
      Option.Option<PullRequestSummary>,
      GitHubCliError | GitHubOutputError
    >;
    readonly findByNumber: (
      repo: string,
      number: number,
      extraFields?: ReadonlyArray<string>,
    ) => Effect.Effect<
      Option.Option<PullRequestSummary>,
      GitHubCliError | GitHubOutputError
    >;
    // Every PR of the repo, newest first, one page.
    readonly list: (
      repo: string,
    ) => Effect.Effect<
      ReadonlyArray<PullRequestSummary>,
      GitHubCliError | GitHubOutputError
    >;
    // Each branch's own pull request of the repo's newest, read a page
    // per entry of `pages`. A PR on two pages (it moved between the
    // reads) is taken from the earlier one.
    readonly ownPullRequests: (
      repo: string,
      pages: ReadonlyArray<ListPage>,
      options?: RunOptions,
    ) => Effect.Effect<
      ReadonlyMap<string, PullRequestSummary>,
      GitHubCliError | GitHubOutputError
    >;
    // The fork's PR the branch was checked out from, or null: the app's
    // PR checkout, like `gh pr checkout`, points branch.<b>.merge at
    // refs/pull/<n>/head. That PR is the branch's own though it comes
    // from a fork.
    readonly checkedOutPullRequest: (
      repo: string,
      branch: string,
    ) => Effect.Effect<number | null>;
    // The same for every branch of the repo, in one git call: branch to
    // the number of the fork's PR it was checked out from.
    readonly checkedOutPullRequests: (
      repo: string,
    ) => Effect.Effect<ReadonlyMap<string, number>>;
    // The commits the branch's merged PRs ended on: from this
    // repository, or the fork's one the branch was checked out from.
    readonly mergedHeads: (
      repo: string,
      branch: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly number: number; readonly head: string }>,
      GitHubCliError | GitHubOutputError
    >;
    // The commit a PR's branch is at on GitHub.
    readonly headOf: (
      repo: string,
      number: number,
    ) => Effect.Effect<string, GitHubCliError | GitHubOutputError>;
    // A failed read means every method and no auto-merge: missing data
    // doesn't block the merge, and --auto is only asked where GitHub is
    // known to accept it.
    readonly mergeSettings: (repo: string) => Effect.Effect<MergeSettings>;
    // The repository's merge-button settings as GitHub has them, none
    // when gh couldn't read them.
    readonly repoMergeConfig: (
      repo: string,
      options?: { readonly timeout?: Duration.Input | undefined },
    ) => Effect.Effect<RepoMergeConfig, GitHubCliError | GitHubOutputError>;
    // Where an open PR stands on its way to merging.
    readonly mergeProgress: (
      repo: string,
      number: number,
    ) => Effect.Effect<MergeProgress, GitHubCliError | GitHubOutputError>;
    // The PR's merge verdict, "" when gh's answer has none.
    readonly mergeStateStatus: (
      repo: string,
      number: number,
    ) => Effect.Effect<string, GitHubCliError>;
    // GitHub's stack holding the PR, none when there is none (or the
    // host has no stacks API).
    readonly stackFor: (
      repo: string,
      number: number,
    ) => Effect.Effect<
      Option.Option<GitHubStack>,
      GitHubCliError | GitHubOutputError
    >;
    // Every PR in one of the repo's GitHub stacks, to that stack's
    // number. Empty when the host has no stacks API.
    readonly stacks: (
      repo: string,
    ) => Effect.Effect<
      ReadonlyMap<number, number>,
      GitHubCliError | GitHubOutputError
    >;
    // GitHub's own stack merge: every PR of the stack up to `number`
    // lands, or none does. Waits for the outcome.
    readonly mergeStackAsync: (
      repo: string,
      number: number,
      method: MergeMethod,
    ) => Effect.Effect<
      AsyncMergeOutcome,
      GitHubCliError | GitHubOutputError | StackMergeFailed
    >;
  }
>()("sm/engine/GitHub") {}

// Long enough for a cold `gh pr list` on a slow link, short enough that
// a wedged gh (no network, a credential helper waiting on a keychain)
// can't hold a card or an agent's describe hostage.
const PROBE_TIMEOUT = Duration.seconds(6);

// A gh asked with no deadline of its own: a proxy's auth prompt or an
// SSO page it can't show leaves one waiting for good, and a merge
// button behind it with it.
const DEFAULT_TIMEOUT = Duration.minutes(2);

// Room for a stack read's every page (`--paginate --slurp`) and a
// sprawling PR's diff.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

// On one line so the call logs as one.
const REPO_MERGE_QUERY =
  "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
  "{ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed } }";

const ASYNC_MERGE_POLL = Duration.seconds(2);
const ASYNC_MERGE_TIMEOUT_MS = 3 * 60 * 1000;

// Which failure gh's stderr describes. The auth failure is the common
// case, and its own message is four lines of instructions. A repo with no
// GitHub remote gets an error that points at `gh auth login` too, so it
// is told apart first. GitHub Actions has gh ask for GH_TOKEN instead.
const reasonOfStderr = (stderr: string): GitHubCliError["reason"] =>
  stderr.includes("none of the git remotes")
    ? "no-github-remote"
    : stderr.includes("gh auth login") || stderr.includes("GH_TOKEN")
      ? "unauthenticated"
      : "failed";

// Ellipsized to `max` characters.
const truncateRunes = (text: string, max: number): string => {
  const chars = [...text];
  return max < 2 || chars.length <= max
    ? text
    : `${chars.slice(0, max - 1).join("")}…`;
};

// What gh wrote to stderr, "" when it said nothing or didn't exit.
export const stderrOf = (error: GitHubCliError): string =>
  Processes.isCommandError(error.cause) ? Processes.stderrOf(error.cause) : "";

// What gh wrote to stdout before it failed, for a partial answer.
export const stdoutOf = (error: GitHubCliError): string =>
  Processes.isCommandError(error.cause) ? Processes.stdoutOf(error.cause) : "";

// gh's own words for a failure: its stderr, else its exit status, else
// why it couldn't be run.
const wordsOf = (error: GitHubCliError): string => {
  const cause = error.cause;
  if (!Processes.isCommandError(cause)) return "";
  if (cause.exitCode !== null) {
    return Processes.stderrOf(cause) || `exit status ${cause.exitCode}`;
  }
  return cause.cause instanceof Error ? cause.cause.message : "";
};

// The failure as one short line, which the status card shows: any other
// failure is the first line of gh's own words.
const reasonOf = (error: GitHubCliError): string => {
  switch (error.reason) {
    case "missing":
      return "gh isn't installed";
    case "unauthenticated":
      return "gh isn't authenticated";
    case "no-github-remote":
      return "no GitHub remote";
    case "timeout":
      return "gh timed out";
    case "failed": {
      const first = wordsOf(error)
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "");
      return first === undefined ? "gh failed" : truncateRunes(first, 60);
    }
  }
};

// The failure as a command reports it, where the status card's one line
// above is too short: everything gh said.
export const commandMessageOf = (error: GitHubCliError): string => {
  switch (error.reason) {
    case "missing":
      return "GitHub CLI isn't installed";
    case "timeout":
      return "gh timed out";
    default:
      return wordsOf(error) || "gh failed";
  }
};

// The PR number a branch's merge ref names (refs/pull/<n>/head), or null.
const pullRequestOfMergeRef = (ref: string): number | null => {
  const match = /^refs\/pull\/(\d+)\/head$/.exec(ref.trim());
  return match ? Number(match[1]) : null;
};

// The repository settings a GraphQL answer carries, none when it has
// no repository.
const RepositoryAnswer = Schema.fromJsonString(
  Schema.Struct({
    data: GoJson.struct(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            mergeCommitAllowed: GoJson.flag,
            squashMergeAllowed: GoJson.flag,
            rebaseMergeAllowed: GoJson.flag,
            autoMergeAllowed: GoJson.flag,
          }),
        ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
      }),
    ),
  }),
);
const repositoryOf = (stdout: string) =>
  Option.flatMap(Schema.decodeOption(RepositoryAnswer)(stdout), ({ data }) =>
    Option.fromNullishOr(data.repository),
  );

const MergeStateAnswer = Schema.fromJsonString(
  Schema.Struct({ mergeStateStatus: GoJson.text }),
);

// A stack as the stacks API answers it, with its pull requests.
const StackAnswer = Schema.Struct({
  number: GoJson.count,
  pull_requests: GoJson.list(
    Schema.Struct({ number: GoJson.count, state: GoJson.text }),
  ),
});
const StacksAnswer = Schema.fromJsonString(Schema.Array(StackAnswer));
// `--paginate --slurp`'s pages of stacks.
const StackPagesAnswer = Schema.fromJsonString(
  Schema.Array(Schema.Array(StackAnswer)),
);

// A host without the stacks API (GHES, the feature off) answers 404.
const hasNoStacksApi = (error: GitHubCliError) =>
  stderrOf(error).includes("HTTP 404");

// An async merge's answer: its status, and the ticket's details.
const AsyncTicket = Schema.fromJsonString(
  Schema.Struct({
    status: GoJson.text,
    details: GoJson.struct(
      Schema.Struct({ message: GoJson.text, uuid: GoJson.text }),
    ),
  }),
);

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = yield* Git.Git;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* Paths.Paths;

  // gh's own precedence for its hosts.yml: GH_CONFIG_DIR, then the XDG
  // config directory. Missing for most users and on a fresh install.
  const knownHosts = Effect.gen(function* () {
    const dir = yield* envVar("GH_CONFIG_DIR");
    const file = path.join(
      dir !== "" ? dir : path.join(paths.configHome, "gh"),
      "hosts.yml",
    );
    return ghKnownHosts(
      yield* fs
        .readFileString(file)
        .pipe(
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed(""),
          ),
        ),
    );
  });

  const hostOf = Effect.fn("GitHub.hostOf")(function* (cwd: string) {
    const [remotes, known] = yield* Effect.all(
      [
        git.listRemoteEntries(cwd),
        knownHosts.pipe(Effect.orElseSucceed(() => ghKnownHosts(""))),
      ],
      { concurrency: 2 },
    );
    return ghHostFor(remotes, known);
  });

  // No stdin, so it never waits on a prompt.
  const gh = (
    cwd: string | undefined,
    host: string | null,
    args: ReadonlyArray<string>,
    options: RunOptions,
  ) =>
    Processes.exec("gh", args, {
      cwd,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      ...(host === null ? {} : { env: { GH_HOST: host }, extendEnv: true }),
    }).pipe(
      Effect.map(({ stdout }) => stdout),
      Effect.mapError(
        (cause) =>
          new GitHubCliError({
            reason:
              cause.reason === "not-found"
                ? "missing"
                : cause.reason === "timed-out"
                  ? "timeout"
                  : reasonOfStderr(Processes.stderrOf(cause)),
            cause,
          }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const run = Effect.fn("GitHub.run")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    options: RunOptions = {},
  ) {
    return yield* gh(cwd, yield* hostOf(cwd), args, options);
  });

  const runOn = Effect.fn("GitHub.runOn")(
    (
      host: string | null,
      args: ReadonlyArray<string>,
      options: RunOptions = {},
    ) => gh(undefined, host, args, options),
  );

  // gh's rows for `args`, failing when it answered with something
  // `decode` can't read.
  const rowsFor = (
    repo: string,
    args: ReadonlyArray<string>,
    { decode = rowsOf, ...runOptions }: RowsOptions = {},
  ) =>
    run(repo, args, runOptions).pipe(
      Effect.flatMap((stdout) =>
        Option.match(decode(stdout), {
          onNone: () =>
            Effect.fail(new GitHubOutputError({ command: "pr list" })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const checkedOutPullRequest = Effect.fn("GitHub.checkedOutPullRequest")(
    (repo: string, branch: string) =>
      git.run(repo, ["config", "--get", `branch.${branch}.merge`]).pipe(
        Effect.map(pullRequestOfMergeRef),
        // Exit 1: the key isn't set.
        Effect.orElseSucceed(() => null),
      ),
  );

  const checkedOutPullRequests = Effect.fn("GitHub.checkedOutPullRequests")(
    function* (repo: string) {
      const numbers = new Map<string, number>();
      const refs = yield* Effect.result(
        git.run(repo, [
          "config",
          "--get-regexp",
          String.raw`^branch\..*\.merge$`,
        ]),
      );
      // Exit 1: no branch has a merge ref.
      if (Result.isFailure(refs)) return numbers;
      for (const line of refs.success.split("\n")) {
        const [key = "", ref = ""] = line.split(" ");
        const branch = /^branch\.(.+)\.merge$/.exec(key)?.[1];
        const number = pullRequestOfMergeRef(ref);
        if (branch && number !== null) numbers.set(branch, number);
      }
      return numbers;
    },
  );

  // The branch's own pull request, any state, with `fields`.
  const ownRow = (
    repo: string,
    branch: string,
    fields: ReadonlyArray<string>,
    options?: RowsOptions,
  ) =>
    Effect.all(
      [
        rowsFor(repo, lookupArgs(branch, "all", fields), options),
        checkedOutPullRequests(repo),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map(([rows, checkedOut]) => ownOf(rows, branch, checkedOut)));

  const cardFor = Effect.fn("GitHub.cardFor")(function* (
    repo: string,
    branch: string,
  ) {
    const own = yield* Effect.result(
      ownRow(
        repo,
        branch,
        [SUMMARY_FIELDS, "autoMergeRequest", "statusCheckRollup"],
        { timeout: PROBE_TIMEOUT },
      ),
    );
    if (Result.isFailure(own)) {
      return {
        found: null,
        unavailable: isOutputError(own.failure)
          ? "unexpected gh output"
          : reasonOf(own.failure),
      };
    }
    if (Option.isNone(own.success)) return { found: null };
    const row = own.success.value;
    const checks = rollupChecks(row.statusCheckRollup);
    return {
      found: { ...summaryOf(row), ...(checks.total > 0 ? { checks } : {}) },
    };
  });

  const owningPullRequest = Effect.fn("GitHub.owningPullRequest")(function* (
    repo: string,
    branch: string,
  ): Effect.fn.Return<OwningLookup> {
    const rows = yield* Effect.result(
      rowsFor(
        repo,
        lookupArgs(branch, "open", ["number,url,title,body,isCrossRepository"]),
        { timeout: PROBE_TIMEOUT },
      ),
    );
    // Not worth a word: no gh, and a repository off GitHub.
    if (Result.isFailure(rows)) {
      const failure = rows.failure;
      if (isOutputError(failure)) {
        return {
          found: null,
          unavailable: "gh's answer didn't parse",
          uncertain: true,
        };
      }
      if (failure.reason === "missing" || failure.reason === "no-github-remote")
        return { found: null };
      return {
        found: null,
        unavailable: reasonOf(failure),
        ...(failure.reason === "unauthenticated" ? {} : { uncertain: true }),
      };
    }
    const own = rows.success.find((row) => !row.isCrossRepository);
    return {
      found:
        own === undefined
          ? null
          : {
              number: own.number,
              url: own.url,
              title: own.title,
              body: own.body,
              isCrossRepository: false,
            },
    };
  });

  const detailFor = Effect.fn("GitHub.detailFor")(
    (repo: string, branch: string, options?: RunOptions) =>
      ownRow(repo, branch, DETAIL_FIELDS, { ...options, decode: detailRowsOf }),
  );

  const find = Effect.fn("GitHub.find")(function* (
    repo: string,
    branch: string,
    extraFields: ReadonlyArray<string> = [],
  ) {
    const own = yield* ownRow(repo, branch, [SUMMARY_FIELDS, ...extraFields]);
    return Option.map(own, summaryOf);
  });

  const findByNumber = Effect.fn("GitHub.findByNumber")(function* (
    repo: string,
    number: number,
    extraFields: ReadonlyArray<string> = [],
  ) {
    const answered = yield* run(repo, [
      "pr",
      "view",
      String(number),
      "--json",
      [SUMMARY_FIELDS, ...extraFields].join(","),
    ]).pipe(Effect.result);
    if (Result.isFailure(answered)) {
      const said = stderrOf(answered.failure);
      if (
        said.includes("Could not resolve") ||
        said.includes("no pull requests found")
      ) {
        return Option.none<PullRequestSummary>();
      }
      return yield* answered.failure;
    }
    const row = rowOf(answered.success);
    if (Option.isSome(row)) return Option.some(summaryOf(row.value));
    return yield* new GitHubOutputError({ command: "pr view" });
  });

  const page = (
    repo: string,
    { state, limit }: ListPage,
    options?: RunOptions,
  ) =>
    rowsFor(
      repo,
      [
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        String(limit),
        "--json",
        SUMMARY_FIELDS,
      ],
      options,
    );

  const list = Effect.fn("GitHub.list")(function* (repo: string) {
    const rows = yield* page(repo, { state: "all", limit: 200 });
    return rows.map(summaryOf);
  });

  const ownPullRequests = Effect.fn("GitHub.ownPullRequests")(function* (
    repo: string,
    pages: ReadonlyArray<ListPage>,
    options?: RunOptions,
  ) {
    const [read, checkedOut] = yield* Effect.all(
      [
        Effect.forEach(pages, (each) => page(repo, each, options), {
          concurrency: "unbounded",
        }),
        checkedOutPullRequests(repo),
      ],
      { concurrency: 2 },
    );
    // Newest first. toSorted is stable, so a PR in two pages keeps the
    // copy from the page listed first.
    const rows = read.flat().toSorted((a, b) => b.number - a.number);
    return ownByBranch(rows.map(summaryOf), checkedOut);
  });

  const mergedHeads = Effect.fn("GitHub.mergedHeads")(function* (
    repo: string,
    branch: string,
  ) {
    const answer = yield* run(
      repo,
      lookupArgs(branch, "merged", ["number,isCrossRepository,headRefOid"]),
    );
    const rows = rowsOf(answer);
    if (Option.isNone(rows)) {
      return yield* new GitHubOutputError({ command: "pr list" });
    }
    const checkedOut = yield* Effect.cached(
      checkedOutPullRequest(repo, branch),
    );
    const heads: Array<{ readonly number: number; readonly head: string }> = [];
    for (const row of rows.value) {
      if (isBranchsOwn(row, yield* checkedOut)) {
        heads.push({ number: row.number, head: row.headRefOid });
      }
    }
    return heads;
  });

  const headOf = Effect.fn("GitHub.headOf")(function* (
    repo: string,
    number: number,
  ) {
    const row = rowOf(
      yield* run(repo, ["pr", "view", String(number), "--json", "headRefOid"]),
    );
    if (Option.isNone(row) || row.value.headRefOid === "") {
      return yield* new GitHubOutputError({ command: "pr view" });
    }
    return row.value.headRefOid;
  });

  // One GraphQL read, since `gh repo view --json` has the three method
  // flags but not autoMergeAllowed. gh fills {owner} and {repo} from the
  // repo's remote.
  const repoMergeConfig = Effect.fn("GitHub.repoMergeConfig")(function* (
    repo: string,
    options: { readonly timeout?: Duration.Input | undefined } = {},
  ) {
    const stdout = yield* run(
      repo,
      [
        "api",
        "graphql",
        "-F",
        "owner={owner}",
        "-F",
        "name={repo}",
        "-f",
        `query=${REPO_MERGE_QUERY}`,
      ],
      options,
    );
    const repository = repositoryOf(stdout);
    if (Option.isNone(repository)) {
      return yield* new GitHubOutputError({ command: "api graphql" });
    }
    return {
      merge: repository.value.mergeCommitAllowed,
      squash: repository.value.squashMergeAllowed,
      rebase: repository.value.rebaseMergeAllowed,
      autoMerge: repository.value.autoMergeAllowed,
    } satisfies RepoMergeConfig;
  });

  const mergeSettings = Effect.fn("GitHub.mergeSettings")(function* (
    repo: string,
  ) {
    const config = yield* Effect.option(repoMergeConfig(repo));
    return mergeSettingsOf(Option.getOrNull(config));
  });

  const mergeProgress = Effect.fn("GitHub.mergeProgress")(function* (
    repo: string,
    number: number,
  ) {
    const stdout = yield* run(repo, [
      "api",
      "graphql",
      "-F",
      `number=${number}`,
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-f",
      `query=${MERGE_PROGRESS_QUERY}`,
    ]);
    const progress = parseMergeProgress(stdout);
    if (progress === undefined) {
      return yield* new GitHubOutputError({ command: "api graphql" });
    }
    return progress;
  });

  const mergeStateStatus = Effect.fn("GitHub.mergeStateStatus")(function* (
    repo: string,
    number: number,
  ) {
    const stdout = yield* run(repo, [
      "pr",
      "view",
      String(number),
      "--json",
      "mergeStateStatus",
    ]);
    return Option.match(Schema.decodeOption(MergeStateAnswer)(stdout), {
      onNone: () => "",
      onSome: (answer) => answer.mergeStateStatus,
    });
  });

  const stackFor = Effect.fn("GitHub.stackFor")(function* (
    repo: string,
    number: number,
  ) {
    const answered = yield* run(repo, [
      "api",
      `repos/{owner}/{repo}/stacks?pull_request=${number}`,
    ]).pipe(Effect.result);
    if (Result.isFailure(answered)) {
      if (hasNoStacksApi(answered.failure)) return Option.none<GitHubStack>();
      return yield* answered.failure;
    }
    const stacks = Schema.decodeOption(StacksAnswer)(answered.success);
    if (Option.isNone(stacks)) {
      return yield* new GitHubOutputError({ command: "api stacks" });
    }
    for (const { pull_requests: entries } of stacks.value) {
      if (entries.some((entry) => entry.number === number)) {
        return Option.some<GitHubStack>(entries);
      }
    }
    return Option.none<GitHubStack>();
  });

  const stacks = Effect.fn("GitHub.stacks")(function* (repo: string) {
    const stackOf = new Map<number, number>();
    const answered = yield* run(repo, [
      "api",
      "--paginate",
      "--slurp",
      "repos/{owner}/{repo}/stacks?per_page=100",
    ]).pipe(Effect.result);
    if (Result.isFailure(answered)) {
      if (hasNoStacksApi(answered.failure)) return stackOf;
      return yield* answered.failure;
    }
    const pages = Schema.decodeOption(StackPagesAnswer)(answered.success);
    if (Option.isNone(pages)) {
      return yield* new GitHubOutputError({ command: "api stacks" });
    }
    for (const stack of pages.value.flat()) {
      for (const pr of stack.pull_requests)
        stackOf.set(pr.number, stack.number);
    }
    return stackOf;
  });

  const asyncTicket = (stdout: string) =>
    Option.map(
      Schema.decodeOption(AsyncTicket)(stdout),
      ({ status, details }) => ({
        status,
        message: details.message,
        uuid: details.uuid,
      }),
    );

  const mergeStackAsync = Effect.fn("GitHub.mergeStackAsync")(function* (
    repo: string,
    number: number,
    method: MergeMethod,
  ) {
    const read = (stdout: string) =>
      Option.match(asyncTicket(stdout), {
        onNone: () =>
          Effect.fail(new GitHubOutputError({ command: "merge-async" })),
        onSome: Effect.succeed,
      });
    let ticket = yield* read(
      yield* run(repo, [
        "api",
        "-X",
        "PUT",
        `repos/{owner}/{repo}/pulls/${number}/merge-async`,
        "-f",
        `merge_method=${method}`,
      ]),
    );
    // An elapsed budget (a sleep or a clock step spends none of it), and
    // a poll that fails is asked again within it: the merge it watches
    // may land all the same. Past it, the PR itself says how it ended.
    const deadline = (yield* elapsedMillis) + ASYNC_MERGE_TIMEOUT_MS;
    while (ticket.status === "pending") {
      if ((yield* elapsedMillis) > deadline) {
        const settled = yield* mergeProgress(repo, number).pipe(Effect.option);
        if (Option.isSome(settled) && settled.value.state === "MERGED") {
          return "merged" as const;
        }
        if (Option.isSome(settled) && settled.value.isInMergeQueue) {
          return "enqueued" as const;
        }
        return yield* new StackMergeFailed({
          number,
          reason: "timeout",
          detail: "",
        });
      }
      yield* Effect.sleep(ASYNC_MERGE_POLL);
      const polled = yield* run(repo, [
        "api",
        `repos/{owner}/{repo}/pulls/${number}/merge-async/${ticket.uuid}`,
      ]).pipe(Effect.flatMap(read), Effect.option);
      if (Option.isSome(polled)) ticket = polled.value;
    }
    if (ticket.status === "merged") return "merged" as const;
    if (ticket.status === "enqueued") return "enqueued" as const;
    return yield* new StackMergeFailed({
      number,
      reason: "refused",
      detail: ticket.message,
    });
  });

  return GitHub.of({
    run,
    runOn,
    hostOf,
    knownHosts,
    cardFor,
    owningPullRequest,
    detailFor,
    find,
    findByNumber,
    list,
    ownPullRequests,
    checkedOutPullRequest,
    checkedOutPullRequests,
    mergedHeads,
    headOf,
    mergeSettings,
    repoMergeConfig,
    mergeProgress,
    mergeStateStatus,
    stackFor,
    stacks,
    mergeStackAsync,
  });
});

export const layer = Layer.effect(GitHub, make);
