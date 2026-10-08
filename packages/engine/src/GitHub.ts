// What the engine asks GitHub, through the user's own `gh`: the pull
// request a branch has. One runner under every lookup, so the install
// check, the deadline and the reasons a lookup couldn't be made are the
// same for each.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { findExecutable } from "./executables.ts";
import * as Git from "./Git.ts";

// A gh that couldn't answer: not installed, failed (its stderr is the
// cause), or past the caller's deadline.
export class GitHubCliError extends Schema.TaggedError<GitHubCliError>()(
  "GitHubCliError",
  {
    reason: Schema.Literals(["missing", "failed", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return "GitHub CLI isn't installed";
      case "failed":
        return "gh failed";
      case "timeout":
        return "gh timed out";
    }
  }
}

// GitHub's record of an armed auto-merge, the method as GraphQL spells
// it (MERGE, SQUASH, REBASE).
export type AutoMergeRequest = { readonly mergeMethod: string };

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

export type PullRequestChecks = {
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

// What ghProbeReason says when no remote is on a GitHub host gh knows,
// so a caller can tell "nothing to look up" from a lookup that failed.
export const NO_GITHUB_REMOTE = "no GitHub remote";

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
// any state, newest first. A few, not one: the filter matches the name
// across every fork, so a stranger's fork PR of the same name may be
// newer than the branch's own.
const lookupArgs = (branch: string, extraFields: ReadonlyArray<string>) => [
  "pr",
  "list",
  "--state",
  "all",
  "--head",
  branch,
  "--limit",
  "10",
  "--json",
  [SUMMARY_FIELDS, ...extraFields].join(","),
];

// gh's stderr folded to one short line. The auth failure is the one
// worth naming: it's the common case and its own message is four lines
// of instructions. A repo with no GitHub remote gets an error that
// points at `gh auth login` too, so it is told apart first.
export function ghProbeReason(stderr: string): string {
  if (stderr.includes("none of the git remotes")) return NO_GITHUB_REMOTE;
  if (stderr.includes("gh auth login")) return "gh isn't authenticated";
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return truncateRunes(trimmed, 60);
  }
  return "gh failed";
}

// Ellipsized to `max` characters.
export function truncateRunes(text: string, max: number): string {
  const chars = [...text];
  if (max < 2 || chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

const reasonOf = (error: GitHubCliError): string => {
  switch (error.reason) {
    case "missing":
      return "gh isn't installed";
    case "timeout":
      return "gh timed out";
    case "failed":
      return ghProbeReason(
        error.cause instanceof Error ? error.cause.message : "",
      );
  }
};

// gh's statusCheckRollup is a mixed array: CheckRun nodes carry status
// and conclusion, StatusContext nodes carry state. One node is one
// verdict.
export function rollupChecks(nodes: ReadonlyArray<unknown>): PullRequestChecks {
  const checks = { total: 0, passing: 0, failing: 0, pending: 0 };
  for (const node of nodes) {
    const field = (key: string) =>
      text((node as Record<string, unknown>)?.[key]);
    let verdict = field("state");
    if (verdict === "") {
      verdict =
        field("status") === "COMPLETED" ? field("conclusion") : "PENDING";
    }
    checks.total++;
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(verdict)) checks.passing++;
    else if (
      [
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
      ].includes(verdict)
    ) {
      checks.failing++;
    } else checks.pending++;
  }
  return checks;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (typeof value === "number" ? value : 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A `gh pr list` row as Go decodes it: a missing field reads as its
// zero value, and the empty ones are left out of the document.
export function summaryOf(row: Record<string, unknown>): PullRequestSummary {
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
    ...(isRecord(autoMerge)
      ? { autoMergeRequest: { mergeMethod: text(autoMerge["mergeMethod"]) } }
      : {}),
  };
}

// gh's JSON array of objects, none when it is something else.
const rowsOf = (stdout: string): Option.Option<Record<string, unknown>[]> => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.every(isRecord)
      ? Option.some(parsed)
      : Option.none();
  } catch {
    return Option.none();
  }
};

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = yield* Git.Git;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const ghPath = findExecutable("gh").pipe(Effect.provideContext(platform));

  const run = Effect.fn("GitHub.run")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly timeout?: Duration.Input | undefined } = {},
  ) {
    const gh = yield* ghPath;
    if (Option.isNone(gh)) {
      return yield* new GitHubCliError({ reason: "missing" });
    }
    const failed = (cause: unknown) =>
      new GitHubCliError({ reason: "failed", cause });
    const answer = Effect.scoped(
      Effect.gen(function* () {
        // In a process group of its own, so a deadline ends gh with the
        // git and credential helper it started.
        const handle = yield* spawner
          .spawn(ChildProcess.make(gh.value, [...args], { cwd }))
          .pipe(Effect.mapError(failed));
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
          return yield* failed(
            new Error(stderr.trim() || `gh exited with ${code}`),
          );
        }
        return stdout;
      }),
    );
    if (options.timeout === undefined) return yield* answer;
    const done = yield* Effect.timeoutOption(answer, options.timeout);
    if (Option.isNone(done)) {
      return yield* new GitHubCliError({ reason: "timeout" });
    }
    return done.value;
  });

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
    const stdout = yield* run(
      repo,
      lookupArgs(branch, ["autoMergeRequest", "statusCheckRollup"]),
      { timeout: PROBE_TIMEOUT },
    ).pipe(Effect.result);
    if (Result.isFailure(stdout)) {
      return { found: null, unavailable: reasonOf(stdout.failure) };
    }
    const rows = rowsOf(stdout.success);
    if (Option.isNone(rows)) {
      return { found: null, unavailable: "unexpected gh output" };
    }
    // Asked once, and only when gh returned a fork's PR.
    const checkedOut = yield* Effect.cached(
      checkedOutPullRequest(repo, branch),
    );
    for (const row of rows.value) {
      if (row["isCrossRepository"] === true) {
        if (count(row["number"]) !== (yield* checkedOut)) continue;
      }
      const rollup = row["statusCheckRollup"];
      const checks = rollupChecks(Array.isArray(rollup) ? rollup : []);
      return {
        found: {
          ...summaryOf(row),
          ...(checks.total > 0 ? { checks } : {}),
        },
      };
    }
    return { found: null };
  });

  const owningPullRequest = Effect.fn("GitHub.owningPullRequest")(function* (
    repo: string,
    branch: string,
  ) {
    const stdout = yield* run(
      repo,
      [
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        branch,
        "--limit",
        "10",
        "--json",
        "number,url,title,body,isCrossRepository",
      ],
      { timeout: PROBE_TIMEOUT },
    ).pipe(Effect.result);
    if (Result.isFailure(stdout)) {
      return { found: null, unavailable: reasonOf(stdout.failure) };
    }
    const own = Option.getOrElse(rowsOf(stdout.success), () => []).find(
      (row) => row["isCrossRepository"] !== true,
    );
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
