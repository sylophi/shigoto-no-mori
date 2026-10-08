// What the engine asks GitHub, through the user's own `gh`: the pull
// request a branch has. One runner under every lookup, so the install
// check, the deadline and the reasons a lookup couldn't be made are the
// same for each.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Git from "./Git.ts";
import { parseJson } from "./json.ts";
import { isNotFound } from "./platformErrors.ts";

// A gh that couldn't answer, sorted where it failed: not installed, not
// signed in, no remote on a GitHub host it knows, any other failure (gh's
// stderr is the cause), or past the caller's deadline.
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

// The open pull request that holds a worktree's title and description.
// `isCrossRepository` is always false, and printed: the document is Go's.
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

// The merge methods GitHub knows, in the order a pick falls back on.
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

// The repo's merge settings: the methods its merge button offers, in
// MERGE_METHODS order, and whether auto-merge may be armed on its PRs.
export type MergeSettings = {
  readonly allowed: ReadonlyArray<MergeMethod>;
  readonly autoMerge: boolean;
};

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
      ? `GitHub is still merging the stack; check PR #${this.number}`
      : `GitHub didn't merge the stack: ${this.detail}`;
  }
}

// A lookup's answer: what it found (null for nothing), or why it
// couldn't look.
export type Lookup<A> = {
  readonly found: A | null;
  readonly unavailable?: string;
};

export class GitHub extends Context.Service<
  GitHub,
  {
    // gh with `args` in `cwd`, failing past `timeout` when one is given.
    readonly run: (
      cwd: string,
      args: ReadonlyArray<string>,
      options?: { readonly timeout?: Duration.Input | undefined },
    ) => Effect.Effect<string, GitHubCliError>;
    // The branch's pull request with its checks, as the status card
    // shows it: the newest that is the branch's own.
    readonly cardFor: (
      repo: string,
      branch: string,
    ) => Effect.Effect<Lookup<PullRequestCard>>;
    // The open pull request from this repository on the branch, which
    // owns the worktree's title and description.
    readonly owningPullRequest: (
      repo: string,
      branch: string,
    ) => Effect.Effect<Lookup<OwningPullRequest>>;
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
    // Whether the PR's branch here was checked out from it, the one way
    // a fork's PR is the branch's own.
    readonly checkedOutFrom: (
      repo: string,
      branch: string,
      number: number,
    ) => Effect.Effect<boolean>;
    // A merged PR from this repository (or the fork's one the branch was
    // checked out from) has the branch as its head. False on any failure.
    readonly hasMergedPullRequest: (
      repo: string,
      branch: string,
    ) => Effect.Effect<boolean>;
    // A failed read means every method and no auto-merge: missing data
    // doesn't block the merge, and --auto is only asked where GitHub is
    // known to accept it.
    readonly mergeSettings: (repo: string) => Effect.Effect<MergeSettings>;
    // What became of an auto-merge just armed: gh's --auto merges at once
    // when the verdict moved since the lookup, and a merge queue queues
    // it. A failed or unreadable read means still armed: gh accepted the
    // merge, and this only shapes the report.
    readonly autoMergeOutcome: (
      repo: string,
      number: number,
    ) => Effect.Effect<"merged" | "queued" | "auto-merge">;
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

// On one line so the call logs as one.
const REPO_MERGE_QUERY =
  "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
  "{ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed } }";

// GraphQL, since `gh pr view --json` doesn't expose isInMergeQueue.
const AUTO_MERGE_OUTCOME_QUERY =
  "query($number: Int!, $owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
  "{ pullRequest(number: $number) { state isInMergeQueue autoMergeRequest { mergeMethod } } } }";

const ASYNC_MERGE_POLL = Duration.seconds(2);
const ASYNC_MERGE_TIMEOUT_MS = 3 * 60 * 1000;

const SUMMARY_FIELDS =
  "number,title,state,isDraft,url,baseRefName,headRefName,isCrossRepository";

// How a branch's pull request is found: gh's server-side --head filter,
// newest first. A few, not one: the filter matches the name across every
// fork, so a stranger's fork PR of the same name may be newer than the
// branch's own.
const lookupArgs = (
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

// Which failure gh's stderr describes. The auth failure is the common
// case, and its own message is four lines of instructions. A repo with no
// GitHub remote gets an error that points at `gh auth login` too, so it
// is told apart first.
const reasonOfStderr = (stderr: string): GitHubCliError["reason"] =>
  stderr.includes("none of the git remotes")
    ? "no-github-remote"
    : stderr.includes("gh auth login")
      ? "unauthenticated"
      : "failed";

// Ellipsized to `max` characters.
const truncateRunes = (text: string, max: number): string => {
  const chars = [...text];
  return max < 2 || chars.length <= max
    ? text
    : `${chars.slice(0, max - 1).join("")}…`;
};

// What gh said, "" when it said nothing.
export const stderrOf = (error: GitHubCliError): string =>
  error.cause instanceof Error ? error.cause.message : "";

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
      const first = stderrOf(error)
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
      return stderrOf(error) || "gh failed";
  }
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (typeof value === "number" ? value : 0);

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

// gh's statusCheckRollup is a mixed array: CheckRun nodes carry status
// and conclusion, StatusContext nodes carry state. One node is one
// verdict.
const rollupChecks = (nodes: unknown): PullRequestChecks => {
  const checks = { total: 0, passing: 0, failing: 0, pending: 0 };
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const fields = Predicate.isObject(node) ? node : {};
    let verdict = text(fields["state"]);
    if (verdict === "") {
      verdict =
        text(fields["status"]) === "COMPLETED"
          ? text(fields["conclusion"])
          : "PENDING";
    }
    checks.total++;
    if (PASSING.has(verdict)) checks.passing++;
    else if (FAILING.has(verdict)) checks.failing++;
    else checks.pending++;
  }
  return checks;
};

type Row = { readonly [key: string]: unknown };

// A `gh pr list` row as Go decodes it: a missing field reads as its zero
// value, and the empty ones are left out of the document.
const summaryOf = (row: Row): PullRequestSummary => {
  const autoMerge = row["autoMergeRequest"];
  return {
    number: count(row["number"]),
    title: text(row["title"]),
    state: text(row["state"]),
    isDraft: row["isDraft"] === true,
    url: text(row["url"]),
    baseRefName: text(row["baseRefName"]),
    headRefName: text(row["headRefName"]),
    ...(row["isCrossRepository"] === true
      ? { isCrossRepository: true as const }
      : {}),
    ...(text(row["mergeStateStatus"]) === ""
      ? {}
      : { mergeStateStatus: text(row["mergeStateStatus"]) }),
    ...(Predicate.isObject(autoMerge)
      ? { autoMergeRequest: { mergeMethod: text(autoMerge["mergeMethod"]) } }
      : {}),
  };
};

// The repository object of a GraphQL answer, undefined when there is none.
const repositoryOf = (stdout: string): Row | undefined => {
  const parsed = Option.getOrUndefined(parseJson(stdout));
  const data = Predicate.isObject(parsed) ? parsed["data"] : undefined;
  const repository = Predicate.isObject(data) ? data["repository"] : undefined;
  return Predicate.isObject(repository) ? repository : undefined;
};

// gh's JSON array of objects, none when it is something else.
const rowsOf = (stdout: string): Option.Option<ReadonlyArray<Row>> => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.every(Predicate.isObject)
      ? Option.some(parsed)
      : Option.none();
  } catch {
    return Option.none();
  }
};

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = yield* Git.Git;

  const run = Effect.fn("GitHub.run")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly timeout?: Duration.Input | undefined } = {},
  ) {
    const failed = (cause: unknown) =>
      new GitHubCliError({ reason: "failed", cause });
    const answer = Effect.scoped(
      Effect.gen(function* () {
        // In a process group of its own, so a deadline ends gh with the
        // git and credential helper it started. No stdin: it never waits
        // on a prompt.
        const handle = yield* spawner
          .spawn(ChildProcess.make("gh", [...args], { cwd, stdin: "ignore" }))
          .pipe(
            Effect.mapError((error) =>
              isNotFound(error)
                ? new GitHubCliError({ reason: "missing" })
                : failed(error),
            ),
          );
        const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
          stream.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.mapError(failed),
          );
        const [stdout, stderr] = yield* Effect.all(
          [collect(handle.stdout), collect(handle.stderr)],
          { concurrency: 2 },
        );
        const code = yield* handle.exitCode.pipe(Effect.mapError(failed));
        if (code !== 0) {
          return yield* new GitHubCliError({
            reason: reasonOfStderr(stderr),
            // Go's wording when gh said nothing.
            cause: new Error(stderr.trim() || `exit status ${code}`),
          });
        }
        return stdout;
      }),
    );
    const done = yield* Effect.timeoutOption(
      answer,
      options.timeout ?? Duration.infinity,
    );
    if (Option.isNone(done)) {
      return yield* new GitHubCliError({ reason: "timeout" });
    }
    return done.value;
  });

  // gh's rows for a lookup, or why there are none to read.
  const listed = (repo: string, args: ReadonlyArray<string>) =>
    run(repo, args, { timeout: PROBE_TIMEOUT }).pipe(
      Effect.map((stdout) =>
        Result.fromOption(rowsOf(stdout), () => "unexpected gh output"),
      ),
      Effect.catchTags({
        GitHubCliError: (error) => Effect.succeed(Result.fail(reasonOf(error))),
      }),
    );

  // The fork PR the branch was checked out from, 0 for none: the app's
  // PR checkout, like `gh pr checkout`, points branch.<b>.merge at
  // refs/pull/<n>/head, and that PR is the branch's own.
  const checkedOutPullRequest = (repo: string, branch: string) =>
    git.run(repo, ["config", "--get", `branch.${branch}.merge`]).pipe(
      Effect.map((ref) => {
        const match = /^refs\/pull\/(\d+)\/head$/.exec(ref.trim());
        return match ? Number(match[1]) : 0;
      }),
      Effect.orElseSucceed(() => 0),
    );

  // The first of a branch's PRs that is its own: not a fork's, or the
  // fork's one it was checked out from. That is asked once, and only
  // when gh returned a fork's PR.
  const ownOf = <
    A extends { readonly number: number; readonly isCrossRepository?: true },
  >(
    repo: string,
    branch: string,
    prs: ReadonlyArray<A>,
  ) =>
    Effect.gen(function* () {
      const checkedOut = yield* Effect.cached(
        checkedOutPullRequest(repo, branch),
      );
      for (const pr of prs) {
        if (
          pr.isCrossRepository !== true ||
          pr.number === (yield* checkedOut)
        ) {
          return Option.some(pr);
        }
      }
      return Option.none<A>();
    });

  const cardFor = Effect.fn("GitHub.cardFor")(function* (
    repo: string,
    branch: string,
  ) {
    const rows = yield* listed(
      repo,
      lookupArgs(branch, "all", [
        SUMMARY_FIELDS,
        "autoMergeRequest",
        "statusCheckRollup",
      ]),
    );
    if (Result.isFailure(rows))
      return { found: null, unavailable: rows.failure };
    const own = yield* ownOf(
      repo,
      branch,
      rows.success.map((row) =>
        Object.assign(summaryOf(row), { rollup: row["statusCheckRollup"] }),
      ),
    );
    if (Option.isNone(own)) return { found: null };
    const { rollup, ...summary } = own.value;
    const checks = rollupChecks(rollup);
    return {
      found: { ...summary, ...(checks.total > 0 ? { checks } : {}) },
    };
  });

  const owningPullRequest = Effect.fn("GitHub.owningPullRequest")(function* (
    repo: string,
    branch: string,
  ): Effect.fn.Return<Lookup<OwningPullRequest>> {
    // Two failures aren't worth a word, as Go's describe takes them: a
    // repository off GitHub, and output that can't be read.
    const stdout = yield* run(
      repo,
      lookupArgs(branch, "open", ["number,url,title,body,isCrossRepository"]),
      { timeout: PROBE_TIMEOUT },
    ).pipe(Effect.result);
    if (Result.isFailure(stdout)) {
      return stdout.failure.reason === "no-github-remote"
        ? { found: null }
        : { found: null, unavailable: reasonOf(stdout.failure) };
    }
    const rows = rowsOf(stdout.success);
    if (Option.isNone(rows)) return { found: null };
    const own = rows.value.find((row) => row["isCrossRepository"] !== true);
    return {
      found:
        own === undefined
          ? null
          : {
              number: count(own["number"]),
              url: text(own["url"]),
              title: text(own["title"]),
              body: text(own["body"]),
              isCrossRepository: false,
            },
    };
  });

  const prList = (repo: string, args: ReadonlyArray<string>) =>
    run(repo, args).pipe(
      Effect.flatMap((stdout) =>
        Option.match(rowsOf(stdout), {
          onNone: () =>
            Effect.fail(new GitHubOutputError({ command: "pr list" })),
          onSome: (rows) => Effect.succeed(rows.map(summaryOf)),
        }),
      ),
    );

  const checkedOutFrom = Effect.fn("GitHub.checkedOutFrom")(function* (
    repo: string,
    branch: string,
    number: number,
  ) {
    return (yield* checkedOutPullRequest(repo, branch)) === number;
  });

  const find = Effect.fn("GitHub.find")(function* (
    repo: string,
    branch: string,
    extraFields: ReadonlyArray<string> = [],
  ) {
    const prs = yield* prList(
      repo,
      lookupArgs(branch, "all", [SUMMARY_FIELDS, ...extraFields]),
    );
    return yield* ownOf(repo, branch, prs);
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
    const parsed = parseJson(answered.success);
    if (Option.isSome(parsed) && Predicate.isObject(parsed.value)) {
      return Option.some(summaryOf(parsed.value));
    }
    return yield* new GitHubOutputError({ command: "pr view" });
  });

  const list = Effect.fn("GitHub.list")(function* (repo: string) {
    return yield* prList(repo, [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "200",
      "--json",
      SUMMARY_FIELDS,
    ]);
  });

  const hasMergedPullRequest = Effect.fn("GitHub.hasMergedPullRequest")(
    function* (repo: string, branch: string) {
      // No deadline, as in Go: unlike the status card, done waits for it.
      const rows = yield* run(
        repo,
        lookupArgs(branch, "merged", ["number,isCrossRepository"]),
      ).pipe(
        Effect.map(rowsOf),
        Effect.orElseSucceed(() => Option.none<ReadonlyArray<Row>>()),
      );
      if (Option.isNone(rows)) return false;
      return Option.isSome(
        yield* ownOf(repo, branch, rows.value.map(summaryOf)),
      );
    },
  );

  // One GraphQL read, since `gh repo view --json` has the three method
  // flags but not autoMergeAllowed. gh fills {owner} and {repo} from the
  // repo's remote.
  const mergeSettings = Effect.fn("GitHub.mergeSettings")(function* (
    repo: string,
  ) {
    const everything: MergeSettings = {
      allowed: MERGE_METHODS,
      autoMerge: false,
    };
    const stdout = yield* run(repo, [
      "api",
      "graphql",
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-f",
      `query=${REPO_MERGE_QUERY}`,
    ]).pipe(Effect.option);
    if (Option.isNone(stdout)) return everything;
    const repository = repositoryOf(stdout.value);
    if (repository === undefined) return everything;
    const flags: Record<MergeMethod, unknown> = {
      merge: repository["mergeCommitAllowed"],
      squash: repository["squashMergeAllowed"],
      rebase: repository["rebaseMergeAllowed"],
    };
    return {
      allowed: MERGE_METHODS.filter((method) => flags[method] === true),
      autoMerge: repository["autoMergeAllowed"] === true,
    };
  });

  const autoMergeOutcome = Effect.fn("GitHub.autoMergeOutcome")(function* (
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
      `query=${AUTO_MERGE_OUTCOME_QUERY}`,
    ]).pipe(Effect.option);
    const repository = Option.isSome(stdout)
      ? repositoryOf(stdout.value)
      : undefined;
    const pr = repository?.["pullRequest"];
    if (!Predicate.isObject(pr)) return "auto-merge" as const;
    if (pr["state"] === "MERGED") return "merged" as const;
    if (pr["isInMergeQueue"] === true) return "queued" as const;
    return "auto-merge" as const;
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
    const parsed = Option.getOrUndefined(parseJson(stdout));
    return text(Predicate.isObject(parsed) ? parsed["mergeStateStatus"] : "");
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
      // A host without the stacks API (GHES, the feature off) answers
      // 404: not an error, just not a GitHub stack.
      if (stderrOf(answered.failure).includes("HTTP 404"))
        return Option.none<GitHubStack>();
      return yield* answered.failure;
    }
    const stacks = Option.getOrUndefined(parseJson(answered.success));
    if (!Array.isArray(stacks)) {
      return yield* new GitHubOutputError({ command: "api stacks" });
    }
    for (const stack of stacks) {
      const entries = Predicate.isObject(stack)
        ? stack["pull_requests"]
        : undefined;
      if (!Array.isArray(entries)) continue;
      const parsed = entries.map((entry) => ({
        number: count(Predicate.isObject(entry) ? entry["number"] : undefined),
        state: text(Predicate.isObject(entry) ? entry["state"] : undefined),
      }));
      if (parsed.some((entry) => entry.number === number)) {
        return Option.some<GitHubStack>(parsed);
      }
    }
    return Option.none<GitHubStack>();
  });

  const asyncTicket = (stdout: string) =>
    Option.flatMap(parseJson(stdout), (parsed) => {
      if (!Predicate.isObject(parsed)) return Option.none();
      const details = Predicate.isObject(parsed["details"])
        ? parsed["details"]
        : {};
      return Option.some({
        status: text(parsed["status"]),
        message: text(details["message"]),
        uuid: text(details["uuid"]),
      });
    });

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
    const deadline = (yield* Clock.currentTimeMillis) + ASYNC_MERGE_TIMEOUT_MS;
    while (ticket.status === "pending") {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new StackMergeFailed({
          number,
          reason: "timeout",
          detail: "",
        });
      }
      yield* Effect.sleep(ASYNC_MERGE_POLL);
      ticket = yield* read(
        yield* run(repo, [
          "api",
          `repos/{owner}/{repo}/pulls/${number}/merge-async/${ticket.uuid}`,
        ]),
      );
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
    cardFor,
    owningPullRequest,
    find,
    findByNumber,
    list,
    checkedOutFrom,
    hasMergedPullRequest,
    mergeSettings,
    autoMergeOutcome,
    mergeStateStatus,
    stackFor,
    mergeStackAsync,
  });
});

export const layer = Layer.effect(GitHub, make);
