// What the app asks gh before any GitHub feature: is it installed and
// signed in, which GitHub repo a checkout belongs to, and that repo's
// merge settings and About text. Every answer is cached, since the
// sidebar, the open worktree and the repo queries all ask on every
// worktree open.
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { findExecutable } from "@shigomori/engine/executables";
import type {
  GhUnavailableReason,
  GithubCliReadiness,
  PullRequestOptions,
  RepoMergeConfig,
} from "@shigomori/contracts/schemas";
import { DEVICE_SETTINGS_DEFAULTS } from "@shigomori/contracts/schemas";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EngineConfig from "@shigomori/engine/Config";
import { ghKnownHosts } from "@shigomori/engine/ghHost";
import * as Git from "@shigomori/engine/Git";
import * as GitHub from "@shigomori/engine/GitHub";
import * as Paths from "@shigomori/engine/Paths";
import * as Ops from "../engineOps";
import { keptAnswer, keptAnswers } from "../util/kept";
import * as Processes from "@shigomori/engine/processes";
import { gh, GH_TIMEOUT_MS } from "./exec";
import { type GithubRepoInfo, parseRemoteUrl } from "./remote";

// gh installed but not usable, for a read that would rather fail than
// answer blank.
export class GhUnavailableError extends Schema.TaggedError<GhUnavailableError>()(
  "GhUnavailableError",
  { reason: Schema.Literals(["gh-missing", "gh-signed-out"]) },
) {
  override get message(): string {
    return `gh is not ready: ${this.reason}`;
  }
}

export class GithubCli extends Context.Service<
  GithubCli,
  {
    // What gh can do, and with the integration toggle whether anything
    // may use it.
    readonly readiness: Effect.Effect<GithubCliReadiness>;
    // The integration toggle and readiness together, naming which check
    // failed, or null when gh can be used. Surfaces that explain
    // themselves (the new-worktree PR mode) read the reason.
    readonly unavailableReason: Effect.Effect<GhUnavailableReason | null>;
    // The first remote whose host gh is logged in to, or null.
    readonly repo: (cwd: string) => Effect.Effect<GithubRepoInfo | null>;
    // The GitHub host gh knows that `url` is a repository on, or null.
    readonly hostOf: (url: string) => Effect.Effect<string | null>;
    // For a path that just gained its GitHub remote (a publish), so the
    // next read sees it rather than a cached "not on GitHub".
    readonly evictRepo: (cwd: string) => Effect.Effect<void>;
    // unavailableReason, else whether the repo is on a GitHub remote:
    // null when gh may be asked about it.
    readonly unavailableFor: (
      cwd: string,
    ) => Effect.Effect<GhUnavailableReason | "no-github-remote" | null>;
    // Null when gh is not ready or the repo is not on GitHub. A gh call
    // that fails (the network, an expired token) fails rather than reads
    // as null, so the renderer asks again instead of keeping "every
    // method allowed".
    readonly mergeConfig: (
      cwd: string,
    ) => Effect.Effect<
      RepoMergeConfig | null,
      GitHub.GitHubCliError | GitHub.GitHubOutputError
    >;
    // The repo's one-line About, null for none, no GitHub remote or the
    // integration off. gh missing or signed out fails rather than reads
    // as null, so the renderer asks again instead of keeping a blank.
    readonly description: (
      cwd: string,
    ) => Effect.Effect<
      string | null,
      GhUnavailableError | Processes.CommandError
    >;
    // Who and what a new pull request can name: the signed-in user, the
    // repo's assignable people and its labels. Ungated, for the action
    // that reads it to gate.
    readonly pullRequestOptions: (
      cwd: string,
    ) => Effect.Effect<
      PullRequestOptions,
      Processes.CommandError | Schema.SchemaError
    >;
  }
>()("sm/host/GithubCli") {}

const READINESS_TTL = Duration.seconds(30);
// Short, so a gh that comes back is seen soon, but long enough that a
// stuck one isn't spawned again by every ask.
const UNANSWERED_PROBE_TTL = Duration.seconds(10);
const KNOWN_HOSTS_TTL = Duration.hours(1);
// Short because users do occasionally `git remote add` mid-session, but
// long enough that one worktree open's queries share one probe. Without
// it a repo with no GitHub remote spends the full query retry budget on
// every open, gh failing with "could not determine OWNER, REPO" each
// time.
const REPO_TTL = Duration.minutes(5);
// Merge-button settings barely change within a session.
const MERGE_CONFIG_TTL = Duration.hours(1);
// An About is rarely edited, and one that is can wait this long.
const DESCRIPTION_TTL = Duration.hours(1);
// A repo's people and labels change rarely, and the create pull request
// dialog reopens often.
const PULL_REQUEST_OPTIONS_TTL = Duration.minutes(5);

// One read for the create pull request dialog's pickers, filled in the
// same way. A list GitHub couldn't resolve an entry of answers a null in
// its place.
const PULL_REQUEST_OPTIONS_QUERY =
  "query($owner: String!, $name: String!) { viewer { login } " +
  "repository(owner: $owner, name: $name) { " +
  "assignableUsers(first: 100) { nodes { login name } } " +
  "labels(first: 100, orderBy: {field: NAME, direction: ASC}) " +
  "{ nodes { name color description } } } }";

const nodesOf = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.Array(Schema.NullOr(node)) });

const decodePullRequestOptions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        viewer: Schema.Struct({ login: Schema.String }),
        repository: Schema.Struct({
          assignableUsers: nodesOf(
            Schema.Struct({
              login: Schema.String,
              name: Schema.NullOr(Schema.String),
            }),
          ),
          labels: nodesOf(
            Schema.Struct({
              name: Schema.String,
              color: Schema.String,
              description: Schema.NullOr(Schema.String),
            }),
          ),
        }),
      }),
    }),
  ),
);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The device settings, for the integration's switch.
  const engineConfig = yield* EngineConfig.Config;
  const git = yield* Git.Git;
  const github = yield* GitHub.GitHub;
  const withGh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(GitHub.GitHub, github),
    );

  // gh's own precedence for its hosts.yml: GH_CONFIG_DIR, then the XDG
  // config directory. Diverging from gh here would leave Enterprise
  // hosts unrecognized for users who set either variable. Set but empty
  // reads as unset, as Config's environment provider reads it.
  const { configHome } = yield* Paths.Paths;
  const hostsFile = path.join(
    Option.getOrElse(
      yield* Config.String("GH_CONFIG_DIR").pipe(Config.option),
      () => path.join(configHome, "gh"),
    ),
    "hosts.yml",
  );

  // The hosts gh is logged in to. github.com always counts, with the
  // file missing (most users, a fresh install) or, for this ask alone,
  // unreadable.
  const knownHosts = (yield* keptAnswer(
    fs.readFileString(hostsFile).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
      Effect.map(ghKnownHosts),
    ),
    KNOWN_HOSTS_TTL,
  )).pipe(Effect.orElseSucceed(() => new Set(["github.com"])));

  // `gh auth token` exits non-zero when not signed in, and is not asked
  // when gh is missing. It reads gh's own store, where `gh auth status`
  // asks GitHub, so a machine offline (or a stale second account) read
  // as signed out. Asked bare first (gh's own default host, GH_HOST and
  // the token variables among it), then per host gh's file knows, since
  // bare it answers for one host alone and an Enterprise login would
  // read as none. The token itself is dropped unread. A gh that did not
  // answer (killed, timed out) reads as signed out, asked again after
  // UNANSWERED_PROBE_TTL.
  const probe = (yield* keptAnswer(
    Effect.gen(function* () {
      const installed = Option.isSome(
        yield* findExecutable("gh").pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
      if (!installed) return { installed, authed: false };
      const asks = [
        [] as string[],
        ...[...(yield* knownHosts)].map((host) => ["--hostname", host]),
      ];
      let unanswered: Processes.CommandError | undefined;
      for (const ask of asks) {
        const answer = yield* gh(["auth", "token", ...ask]).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => {
              if (error.reason !== "failed" || error.exitCode === null) {
                unanswered = error;
              }
              return false;
            }),
          ),
        );
        if (answer) return { installed, authed: true };
      }
      if (unanswered !== undefined) return yield* unanswered;
      return { installed, authed: false };
    }).pipe(withGh),
    READINESS_TTL,
    { failures: UNANSWERED_PROBE_TTL },
  )).pipe(Effect.orElseSucceed(() => ({ installed: true, authed: false })));

  const repos = yield* keptAnswers(
    (cwd: string) =>
      Effect.gen(function* () {
        const [remotes, hosts] = yield* Effect.all(
          [git.listRemoteEntries(cwd), knownHosts],
          { concurrency: 2 },
        );
        for (const { url } of remotes) {
          const parsed = parseRemoteUrl(url);
          if (parsed && hosts.has(parsed.host)) return parsed;
        }
        return null;
      }),
    REPO_TTL,
  );

  // The engine's read at the host's gh deadline, kept only when it read.
  const mergeConfigs = yield* keptAnswers(
    (cwd: string) => github.repoMergeConfig(cwd, { timeout: GH_TIMEOUT_MS }),
    MERGE_CONFIG_TTL,
  );

  const pullRequestOptions = yield* keptAnswers(
    (cwd: string) =>
      gh(
        [
          "api",
          "graphql",
          "-F",
          "owner={owner}",
          "-F",
          "name={repo}",
          "-f",
          `query=${PULL_REQUEST_OPTIONS_QUERY}`,
        ],
        { cwd },
      ).pipe(
        Effect.flatMap(({ stdout }) => decodePullRequestOptions(stdout)),
        Effect.map(
          ({ data: { viewer, repository } }): PullRequestOptions => ({
            viewer: viewer.login,
            people: repository.assignableUsers.nodes.flatMap((n) =>
              n ? [n] : [],
            ),
            labels: repository.labels.nodes.flatMap((n) => (n ? [n] : [])),
          }),
        ),
        withGh,
      ),
    PULL_REQUEST_OPTIONS_TTL,
  );

  // Keyed by the repo (host/owner/repo), so clones of one repo share it.
  const descriptions = yield* keptAnswers(
    (slug: string) =>
      gh(
        [
          "api",
          `repos/${slug.slice(slug.indexOf("/") + 1)}`,
          "--jq",
          '.description // ""',
        ],
        { host: slug.slice(0, slug.indexOf("/")) },
      ).pipe(
        Effect.map(({ stdout }) => stdout.trim() || null),
        withGh,
      ),
    DESCRIPTION_TTL,
  );

  const unavailableReason = Effect.gen(function* () {
    const config = yield* Ops.readGlobalConfig().pipe(
      Effect.provideService(EngineConfig.Config, engineConfig),
      Effect.orDie,
    );
    if (!(config.githubCli ?? DEVICE_SETTINGS_DEFAULTS.githubCli)) {
      return "integration-off" as const;
    }
    const { installed, authed } = yield* probe;
    if (!installed) return "gh-missing" as const;
    if (!authed) return "gh-signed-out" as const;
    return null;
  }).pipe(Effect.withSpan("GithubCli.unavailableReason"));

  const repo = Effect.fn("GithubCli.repo")((cwd: string) => repos.get(cwd));

  const unavailableFor = Effect.fn("GithubCli.unavailableFor")(function* (
    cwd: string,
  ) {
    const reason = yield* unavailableReason;
    if (reason !== null) return reason;
    return (yield* repo(cwd)) === null ? ("no-github-remote" as const) : null;
  });

  return GithubCli.of({
    readiness: Effect.all([probe, unavailableReason], {
      concurrency: 2,
    }).pipe(
      Effect.map(([answer, unavailable]) => ({ ...answer, unavailable })),
      Effect.withSpan("GithubCli.readiness"),
    ),
    unavailableReason,
    repo,
    hostOf: Effect.fn("GithubCli.hostOf")(function* (url: string) {
      const parsed = parseRemoteUrl(url.trim());
      if (parsed === null) return null;
      return (yield* knownHosts).has(parsed.host) ? parsed.host : null;
    }),
    evictRepo: Effect.fn("GithubCli.evictRepo")((cwd: string) =>
      repos.invalidate(cwd),
    ),
    unavailableFor,
    mergeConfig: Effect.fn("GithubCli.mergeConfig")(function* (cwd) {
      if ((yield* unavailableFor(cwd)) !== null) return null;
      return yield* mergeConfigs.get(cwd);
    }),
    // The repo the app takes the project for (its GitHub links open
    // it), not gh's base repo, which for a fork is the parent.
    description: Effect.fn("GithubCli.description")(function* (cwd) {
      const reason = yield* unavailableReason;
      if (reason === "integration-off") return null;
      if (reason !== null) return yield* new GhUnavailableError({ reason });
      const info = yield* repo(cwd);
      if (info === null) return null;
      return yield* descriptions.get(`${info.host}/${info.owner}/${info.repo}`);
    }),
    pullRequestOptions: Effect.fn("GithubCli.pullRequestOptions")((cwd) =>
      pullRequestOptions.get(cwd),
    ),
  });
});

export const layer = Layer.effect(GithubCli, make);
