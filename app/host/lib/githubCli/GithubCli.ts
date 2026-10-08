// What the app asks gh before any GitHub feature: is it installed and
// signed in, which GitHub repo a checkout belongs to, and that repo's
// merge settings and About text. Every answer is cached, since the
// sidebar, the open worktree and the repo queries all ask on every
// worktree open.
import type {
  GhUnavailableReason,
  GithubCliReadiness,
  RepoMergeConfig,
} from "@shigomori/contracts/schemas";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { envSetting } from "@shared/config";
import { readGlobalConfig } from "../config/global";
import { listRemoteEntries } from "../git/remotes";
import { answersFor } from "../util/cacheTtl";
import * as Processes from "../util/processes";
import * as PromiseAdapter from "../util/promiseAdapter";
import { gh } from "./exec";
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
    readonly readiness: Effect.Effect<GithubCliReadiness>;
    // The integration toggle and readiness together, naming which check
    // failed, or null when gh can be used. Surfaces that explain
    // themselves (the new-worktree PR mode) read the reason.
    readonly unavailableReason: Effect.Effect<GhUnavailableReason | null>;
    // The first remote whose host gh is logged in to, or null.
    readonly repo: (cwd: string) => Effect.Effect<GithubRepoInfo | null>;
    // The gate for read paths: gh ready, and the repo on a GitHub
    // remote. Mutations check the reason so their errors stay specific.
    readonly readyForRepo: (cwd: string) => Effect.Effect<boolean>;
    // Null when gh can't say.
    readonly mergeConfig: (
      cwd: string,
    ) => Effect.Effect<RepoMergeConfig | null>;
    // The repo's one-line About, null for none, no GitHub remote or the
    // integration off. gh missing or signed out fails rather than reads
    // as null, so the renderer, which keeps the answer for the launch,
    // asks again instead of keeping a blank.
    readonly description: (
      cwd: string,
    ) => Effect.Effect<
      string | null,
      GhUnavailableError | Processes.CommandError
    >;
  }
>()("sm/host/GithubCli") {}

const READINESS_TTL = Duration.seconds(30);
const KNOWN_HOSTS_TTL = Duration.hours(1);
// Short because users do occasionally `git remote add` mid-session, but
// long enough that one worktree open's queries share one probe. Without
// it a repo with no GitHub remote spends the full query retry budget on
// every open, gh failing with "could not determine OWNER, REPO" each
// time.
const REPO_TTL = Duration.minutes(5);
// Merge-button settings barely change within a session.
const MERGE_CONFIG_TTL = Duration.hours(1);

// One GraphQL read: `gh repo view --json` has the three method flags
// but not autoMergeAllowed. gh fills {owner} and {repo} from the
// repo's remote in field values the way it does in REST paths. The
// same query as the CLI's (cli/cmd_merge.go repoMergeQuery).
const REPO_MERGE_QUERY =
  "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
  "{ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed } }";

const decodeRepoMergeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          mergeCommitAllowed: Schema.Boolean,
          squashMergeAllowed: Schema.Boolean,
          rebaseMergeAllowed: Schema.Boolean,
          autoMergeAllowed: Schema.Boolean,
        }),
      }),
    }),
  ),
);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const withSpawner = Effect.provideService(
    ChildProcessSpawner.ChildProcessSpawner,
    spawner,
  );

  // `gh auth status` exits non-zero when not signed in, and is not
  // asked when gh is missing.
  const readiness = yield* Effect.gen(function* () {
    const installed = (yield* Processes.resolveOnPath("gh")) !== null;
    const authed =
      installed &&
      (yield* gh(["auth", "status"]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
    return { installed, authed };
  }).pipe(withSpawner, Effect.cachedWithTTL(READINESS_TTL));

  // Mirrors gh's own config-dir precedence: GH_CONFIG_DIR beats
  // XDG_CONFIG_HOME beats ~/.config/gh. Diverging from gh here would
  // make GHE hosts silently unrecognized for users who set either.
  const hostsPath = () => {
    const override = envSetting("GH_CONFIG_DIR");
    if (override) return path.join(override, "hosts.yml");
    const xdg = envSetting("XDG_CONFIG_HOME");
    if (xdg) return path.join(xdg, "gh", "hosts.yml");
    return path.join(envSetting("HOME") ?? "", ".config", "gh", "hosts.yml");
  };

  // gh keeps its logged-in hosts as the keys of a top-level YAML map,
  // which a regex over "<host>:" lines reads without a YAML parser.
  // github.com always counts, with the file missing (most users, a
  // fresh install) or unreadable.
  const knownHosts = yield* Effect.suspend(() =>
    fs.readFileString(hostsPath()),
  ).pipe(
    Effect.map((content) => {
      const hosts = new Set<string>(["github.com"]);
      for (const line of content.split("\n")) {
        const m = line.match(/^([^\s:#]+):\s*$/);
        if (m?.[1]) hosts.add(m[1]);
      }
      return hosts;
    }),
    Effect.orElseSucceed(() => new Set(["github.com"])),
    Effect.cachedWithTTL(KNOWN_HOSTS_TTL),
  );

  const repos = yield* Cache.makeWith(
    (cwd: string) =>
      Effect.gen(function* () {
        const [remotes, hosts] = yield* Effect.all(
          [Effect.promise(() => listRemoteEntries(cwd)), knownHosts],
          { concurrency: 2 },
        );
        for (const { url } of remotes) {
          const parsed = parseRemoteUrl(url);
          if (parsed && hosts.has(parsed.host)) return parsed;
        }
        return null;
      }),
    { capacity: Infinity, timeToLive: answersFor(REPO_TTL) },
  );

  const mergeConfigs = yield* Cache.makeWith(
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
          `query=${REPO_MERGE_QUERY}`,
        ],
        { cwd },
      ).pipe(
        Effect.flatMap(({ stdout }) => decodeRepoMergeConfig(stdout)),
        Effect.map(
          ({ data: { repository } }): RepoMergeConfig => ({
            merge: repository.mergeCommitAllowed,
            squash: repository.squashMergeAllowed,
            rebase: repository.rebaseMergeAllowed,
            autoMerge: repository.autoMergeAllowed,
          }),
        ),
        withSpawner,
      ),
    { capacity: Infinity, timeToLive: answersFor(MERGE_CONFIG_TTL) },
  );

  // Read once per launch and keyed by the repo (host/owner/repo), so
  // clones of one repo share it: an About is rarely edited, and one that is can wait.
  const descriptions = yield* Cache.makeWith(
    (slug: string) =>
      gh([
        "api",
        "--hostname",
        slug.slice(0, slug.indexOf("/")),
        `repos/${slug.slice(slug.indexOf("/") + 1)}`,
        "--jq",
        '.description // ""',
      ]).pipe(
        Effect.map(({ stdout }) => stdout.trim() || null),
        withSpawner,
      ),
    { capacity: Infinity, timeToLive: answersFor(Duration.infinity) },
  );

  const unavailableReason = Effect.gen(function* () {
    const config = yield* Effect.promise(readGlobalConfig);
    if (config.githubCli === false) return "integration-off" as const;
    const { installed, authed } = yield* readiness;
    if (!installed) return "gh-missing" as const;
    if (!authed) return "gh-signed-out" as const;
    return null;
  }).pipe(Effect.withSpan("GithubCli.unavailableReason"));

  const repo = Effect.fn("GithubCli.repo")((cwd: string) =>
    Cache.get(repos, cwd),
  );

  const readyForRepo = Effect.fn("GithubCli.readyForRepo")(function* (
    cwd: string,
  ) {
    if ((yield* unavailableReason) !== null) return false;
    return (yield* repo(cwd)) !== null;
  });

  return GithubCli.of({
    readiness: readiness.pipe(Effect.withSpan("GithubCli.readiness")),
    unavailableReason,
    repo,
    readyForRepo,
    mergeConfig: Effect.fn("GithubCli.mergeConfig")(function* (cwd) {
      if (!(yield* readyForRepo(cwd))) return null;
      return yield* Cache.get(mergeConfigs, cwd).pipe(
        Effect.orElseSucceed(() => null),
      );
    }),
    // The repo the app takes the project for (its GitHub links open
    // it), not gh's base repo, which for a fork is the parent.
    description: Effect.fn("GithubCli.description")(function* (cwd) {
      const reason = yield* unavailableReason;
      if (reason === "integration-off") return null;
      if (reason !== null) return yield* new GhUnavailableError({ reason });
      const info = yield* repo(cwd);
      if (info === null) return null;
      return yield* Cache.get(
        descriptions,
        `${info.host}/${info.owner}/${info.repo}`,
      );
    }),
  });
});

export const layer = Layer.effect(GithubCli, make);

// The Promise face, for the githubCli handlers and the PR code.
const promiseAdapter = PromiseAdapter.forService(GithubCli, "gh");
export const adapter = promiseAdapter.layer;
const { call } = promiseAdapter;

export const getGithubCliReadiness = () => call((cli) => cli.readiness);
export const ghUnavailableReason = () => call((cli) => cli.unavailableReason);
export const ghReady = async () => (await ghUnavailableReason()) === null;
export const getGithubRepoInfo = (cwd: string) => call((cli) => cli.repo(cwd));
export const ghReadyForRepo = (cwd: string) =>
  call((cli) => cli.readyForRepo(cwd));
export const getRepoMergeConfig = (cwd: string) =>
  call((cli) => cli.mergeConfig(cwd));
export const getRepoDescription = (cwd: string) =>
  call((cli) => cli.description(cwd));
