// What the engine asks GitHub, through the user's own `gh`: the pull
// request a branch has. One runner under every lookup, so the install
// check, the deadline and the reasons a lookup couldn't be made are the
// same for each.
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
type PullRequestSummary = {
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
  }
>()("sm/engine/GitHub") {}

// Long enough for a cold `gh pr list` on a slow link, short enough that
// a wedged gh (no network, a credential helper waiting on a keychain)
// can't hold a card or an agent's describe hostage.
const PROBE_TIMEOUT = Duration.seconds(6);

const SUMMARY_FIELDS =
  "number,title,state,isDraft,url,baseRefName,headRefName,isCrossRepository";

// How a branch's pull request is found: gh's server-side --head filter,
// newest first. A few, not one: the filter matches the name across every
// fork, so a stranger's fork PR of the same name may be newer than the
// branch's own.
const lookupArgs = (
  branch: string,
  state: "all" | "open",
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
      const stderr = error.cause instanceof Error ? error.cause.message : "";
      const first = stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "");
      return first === undefined ? "gh failed" : truncateRunes(first, 60);
    }
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
            cause: new Error(stderr.trim() || `gh exited with ${code}`),
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
    // Asked once, and only when gh returned a fork's PR.
    const checkedOut = yield* Effect.cached(
      checkedOutPullRequest(repo, branch),
    );
    for (const row of rows.success) {
      if (
        row["isCrossRepository"] === true &&
        count(row["number"]) !== (yield* checkedOut)
      ) {
        continue;
      }
      const checks = rollupChecks(row["statusCheckRollup"]);
      return {
        found: { ...summaryOf(row), ...(checks.total > 0 ? { checks } : {}) },
      };
    }
    return { found: null };
  });

  const owningPullRequest = Effect.fn("GitHub.owningPullRequest")(function* (
    repo: string,
    branch: string,
  ) {
    const rows = yield* listed(
      repo,
      lookupArgs(branch, "open", ["number,url,title,body,isCrossRepository"]),
    );
    if (Result.isFailure(rows))
      return { found: null, unavailable: rows.failure };
    const own = rows.success.find((row) => row["isCrossRepository"] !== true);
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

  return GitHub.of({ run, cardFor, owningPullRequest });
});

export const layer = Layer.effect(GitHub, make);
