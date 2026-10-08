// A project's worktrees: which checkouts there are (their identities),
// what each one's row says (its sync, changes, commits and marks), the
// status card, finding the worktree a command means, and the marks and
// descriptions the app and agents set. The rows and documents keep the
// shapes `sm worktrees ... --json` prints, field for field.
import { isValidWorktreeDirName } from "@shigomori/contracts/predicates/worktreeDirName";
import type { CommitSummary } from "@shigomori/contracts/schemas";
import { isUntracked } from "@shigomori/contracts/schemas";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "./Config.ts";
import { findExecutable } from "./executables.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import type { WorktreeEntry } from "./gitParse.ts";
import { splitRemoteRef } from "./gitParse.ts";
import * as Layout from "./Layout.ts";
import * as Paths from "./Paths.ts";
import {
  matchPorts,
  parsePortPoolConfig,
  PORT_POOL_CONFIG,
  type PortInfo,
} from "./ports.ts";
import * as Registry from "./Registry.ts";
import type { RegisteredProject } from "./Registry.ts";
import {
  type ShelfObservation,
  type ShelfSnapshot,
  shelfWorked,
  snapshotOf,
} from "./shelf.ts";
import * as WorktreeData from "./WorktreeData.ts";
import { isManagedPath, worktreeIdFromPath } from "./worktreeLayout.ts";

// --- the documents --------------------------------------------------------

// A checkout as `git worktree list` and the layout name it, with no
// probes behind it.
export type WorktreeIdentity = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  // The branch checked out, the short hash when detached, or
  // UNKNOWN_BRANCH.
  readonly branch: string;
  readonly path: string;
  readonly isPrimary: boolean;
  // Outside every managed base. Never true together with isPrimary in a
  // row's flags, though the primary also sits outside them.
  readonly isExternal: boolean;
  readonly detached: boolean;
  // `git worktree lock`ed: git keeps it while its directory is missing.
  readonly locked: boolean;
};

// What a checkout with neither a branch nor a detached HEAD shows.
export const UNKNOWN_BRANCH = "(unknown)";

// A worktree and the project it belongs to.
export type Located = {
  readonly project: RegisteredProject;
  readonly worktree: WorktreeIdentity;
};

// A row of `sm worktrees list --json`. The optional fields are left out
// when empty.
export type WorktreeRow = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly branch: string;
  readonly path: string;
  readonly ahead: number;
  readonly behind: number;
  readonly hasUpstream: boolean;
  readonly hasRemote: boolean;
  readonly divergedClean: boolean;
  readonly behindPrimary: number;
  readonly unpushedCount: number;
  readonly primaryRef?: string;
  readonly primaryBranch?: string;
  readonly mergedIntoPrimary: boolean;
  readonly changedCount: number;
  readonly lastChangeAt?: number;
  readonly createdAt?: number;
  readonly recentCommits: ReadonlyArray<CommitSummary>;
  readonly isPrimary: boolean;
  readonly isExternal: boolean;
  readonly detached: boolean;
  readonly shelved: boolean;
  readonly autoPull: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly projectName: string;
};

// A row of `sm worktrees list --identities --json`: the identity and
// its marks, with the project's primary ref when asked for.
export type IdentityRow = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly branch: string;
  readonly path: string;
  readonly isPrimary: boolean;
  readonly isExternal: boolean;
  readonly detached: boolean;
  readonly shelved: boolean;
  readonly autoPull: boolean;
  readonly primaryRef?: string;
  readonly primaryBranch?: string;
};

// The divergence of HEAD from a ref.
type Sync = { readonly ahead: number; readonly behind: number };

// `sm worktrees status --json`: one worktree's card.
export type StatusCard = {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly name: string;
  readonly branch: string;
  readonly path: string;
  readonly isPrimary: boolean;
  readonly isExternal: boolean;
  readonly detached: boolean;
  readonly shelved: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly git: {
    // Null without an upstream (never pushed, or detached).
    readonly upstream: Sync | null;
    // Null when the project's base branch doesn't resolve here.
    readonly base: (Sync & { readonly ref: string }) | null;
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
    readonly conflicted: number;
    readonly changedCount: number;
    // Repo-wide: git keeps one stash stack per repository.
    readonly stashCount: number;
    readonly lastCommit: CommitSummary | null;
  };
  readonly ports: ReadonlyArray<PortInfo>;
  readonly portPool: {
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly configured: boolean;
  };
  readonly scripts: { readonly setup?: string; readonly teardown?: string };
  // Null when the branch has no PR, when the lookup couldn't run
  // (prUnavailable says why), or when it was skipped (prSkipped).
  readonly pr: GitHub.PullRequestCard | null;
  readonly prUnavailable?: string;
  readonly prSkipped?: true;
  readonly autoPull: boolean;
  readonly primaryBranch?: string;
};

// What `sm worktrees describe` shows: the worktree's own pair, beside
// the open pull request that takes their place when there is one.
export type DescriptionView = {
  readonly title: string;
  readonly description: string;
  readonly pullRequest: GitHub.OwningPullRequest | null;
};

// A listing over several projects: the rows of each that could be read,
// in project order, and the projects that couldn't.
export type Listing<A> = {
  readonly rows: ReadonlyArray<A>;
  readonly skipped: ReadonlyArray<{
    readonly project: RegisteredProject;
    readonly error: Git.GitError;
  }>;
};

// Where a command runs: the registered projects, the worktree the
// directory sits in when a registered project owns it, else the root
// of the unregistered repository it sits in.
export type Here = {
  readonly cwd: string;
  readonly projects: ReadonlyArray<RegisteredProject>;
  readonly current: Located | undefined;
  readonly unregisteredRepo: string | undefined;
};

// How a command names its worktree: by the ids the app holds, or by a
// name, a <project>/<name>, a path, or nothing (the one at the cwd).
export type Target = {
  readonly ref?: string | undefined;
  readonly project?: string | undefined;
  readonly worktreeId?: string | undefined;
  readonly projectId?: string | undefined;
};

// --- errors ---------------------------------------------------------------

export class UnknownWorktree extends Schema.TaggedError<UnknownWorktree>()(
  "UnknownWorktree",
  { worktreeId: Schema.String },
) {
  override get message(): string {
    return `Unknown worktree: ${this.worktreeId}`;
  }
}

// A ref that names no single project or worktree. `usage` is whether
// the command line was what was wrong (the terminal exits 2), and
// `projects` are the registered names the hint lists.
export class TargetError extends Schema.TaggedError<TargetError>()(
  "TargetError",
  {
    reason: Schema.Literals([
      "not-in-project",
      "unregistered-project",
      "unknown-project",
      "ambiguous-project",
      "no-project-at",
      "no-primary",
      "not-a-worktree",
      "name-in-project",
      "unregistered-worktree",
      "not-in-worktree",
      "keyword-needs-project",
      "no-such-worktree",
      "ambiguous-worktree",
    ]),
    ref: Schema.String,
    matches: Schema.Array(Schema.String),
    projects: Schema.Array(Schema.String),
    binary: Schema.String,
  },
) {
  get usage(): boolean {
    return !["no-primary", "not-a-worktree", "no-such-worktree"].includes(
      this.reason,
    );
  }

  override get message(): string {
    const hint =
      this.projects.length === 0
        ? "No projects are registered yet. Add the repo in the Shigoto no Mori app first."
        : `Registered projects: ${this.projects.join(", ")}.`;
    const quoted = JSON.stringify(this.ref);
    switch (this.reason) {
      case "not-in-project":
        return `Not inside a registered project; pass -p <project>. ${hint}`;
      case "unregistered-project":
        return `This repo (${this.ref}) isn't registered as a project. Add it in the app, or target a project with -p. ${hint}`;
      case "unknown-project":
        return `Unknown project ${quoted}. ${hint}`;
      case "ambiguous-project":
        return `${this.matches.length} projects are named ${quoted}. Name the one you mean by its path: ${this.matches.join(", ")}.`;
      case "no-project-at":
        return `No registered project at ${this.ref}. ${hint}`;
      case "no-primary":
        return `${this.ref} has no primary checkout (a bare repository's checkouts are all linked worktrees). Name one of them instead (see \`${this.binary} list -p ${this.ref}\`).`;
      case "not-a-worktree":
        return `${this.ref} isn't a worktree of any registered project.`;
      case "name-in-project":
        return `Pass a worktree name to target in ${this.ref} (see \`${this.binary} list -p ${this.ref}\`).`;
      case "unregistered-worktree":
        return `This repo (${this.ref}) isn't registered as a project, so there is no worktree to target here. Pass a worktree name (see \`${this.binary} list\`).`;
      case "not-in-worktree":
        return `Not inside a worktree; pass a worktree name (see \`${this.binary} list\`).`;
      case "keyword-needs-project":
        return `${quoted} needs a project when outside one. Use <project>/${this.ref} or -p <project>.`;
      case "no-such-worktree":
        return `No worktree named ${quoted}${this.matches.length === 1 ? ` in project ${this.matches[0]}` : ""}.`;
      case "ambiguous-worktree":
        return `${quoted} is ambiguous (${this.matches.join(", ")}). Qualify it as <project>/<name>.`;
    }
  }
}

// What the marks can't be set on.
export class MarkRefused extends Schema.TaggedError<MarkRefused>()(
  "MarkRefused",
  { reason: Schema.Literals(["primary", "external"]) },
) {
  override get message(): string {
    return this.reason === "primary"
      ? "The primary checkout can't be shelved"
      : "External worktrees can't be shelved";
  }
}

// GitHub's own limits for a pull request's title and body, so a
// description the worktree outgrows still fits the PR it becomes.
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 65536;

export class DescribeRefused extends Schema.TaggedError<DescribeRefused>()(
  "DescribeRefused",
  {
    reason: Schema.Literals([
      "external",
      "title-control",
      "title-length",
      "description-length",
    ]),
    binary: Schema.String,
  },
) {
  // The command line was wrong, not the worktree.
  get usage(): boolean {
    return this.reason !== "external";
  }

  override get message(): string {
    switch (this.reason) {
      case "external":
        return `External worktrees have no data file to hold a title. Adopt it first (${this.binary} adopt).`;
      case "title-control":
        return "A title is one line of text, without tabs or other control characters.";
      case "title-length":
        return `A title is at most ${MAX_TITLE} characters.`;
      case "description-length":
        return `A description is at most ${MAX_DESCRIPTION} characters.`;
    }
  }
}

// While the branch has an open pull request, its title and body are the
// worktree's, and a change belongs on the PR.
export class PullRequestOwnsDescription extends Schema.TaggedError<PullRequestOwnsDescription>()(
  "PullRequestOwnsDescription",
  { worktree: Schema.String, number: Schema.Int },
) {
  override get message(): string {
    return `${this.worktree} has open PR #${this.number}, which gives it its title and description. Edit the PR instead: gh pr edit ${this.number} --title … --body …`;
  }
}

// --- the service ----------------------------------------------------------

export class Worktrees extends Context.Service<
  Worktrees,
  {
    // The project's checkouts in git's order. Not memoized: the host
    // lives long, and a checkout git adds behind its back must show.
    readonly identities: (
      project: RegisteredProject,
    ) => Effect.Effect<ReadonlyArray<WorktreeIdentity>, Git.GitError>;
    // Every project's identities, primary first, with their marks.
    readonly identityList: (
      projects: ReadonlyArray<RegisteredProject>,
      options: { readonly primaryRef: boolean },
    ) => Effect.Effect<Listing<IdentityRow>>;
    // One worktree's identity document.
    readonly identityRow: (
      located: Located,
      options: { readonly primaryRef: boolean },
    ) => Effect.Effect<IdentityRow>;
    // Every project's rows, primary first. Settles the shelf.
    readonly list: (
      projects: ReadonlyArray<RegisteredProject>,
    ) => Effect.Effect<Listing<WorktreeRow>>;
    // One worktree's row. `settle` settles its shelf as the listing does.
    readonly row: (
      located: Located,
      options?: { readonly settle?: boolean },
    ) => Effect.Effect<WorktreeRow>;
    readonly status: (
      located: Located,
      options: { readonly pullRequest: boolean },
    ) => Effect.Effect<StatusCard>;

    // Where `cwd` is among the registered projects.
    readonly here: (cwd: string) => Effect.Effect<Here>;
    // The project `ref` names (a name, an id, a path), or the one at the
    // cwd without one.
    readonly resolveProject: (
      here: Here,
      ref: string | undefined,
    ) => Effect.Effect<RegisteredProject, TargetError>;
    readonly resolveProjectById: (
      here: Here,
      projectId: string,
    ) => Effect.Effect<RegisteredProject, Registry.UnknownProject>;
    // The worktree a command means. The reserved names root and primary
    // are the project's primary checkout.
    readonly resolve: (
      here: Here,
      target: Target,
    ) => Effect.Effect<
      Located,
      TargetError | UnknownWorktree | Registry.UnknownProject | Git.GitError
    >;

    readonly setShelved: (
      worktree: WorktreeIdentity,
      on: boolean,
    ) => Effect.Effect<void, MarkRefused>;
    readonly setAutoPull: (
      worktree: WorktreeIdentity,
      on: boolean,
    ) => Effect.Effect<void>;
    readonly description: (
      located: Located,
    ) => Effect.Effect<DescriptionView, DescribeRefused>;
    // Sets the title, the description, or both, and answers the row.
    readonly describe: (
      located: Located,
      change: { readonly title?: string; readonly description?: string },
    ) => Effect.Effect<
      WorktreeRow,
      DescribeRefused | PullRequestOwnsDescription
    >;
  }
>()("sm/engine/Worktrees") {}

// --- helpers --------------------------------------------------------------

const deriveBranch = (entry: WorktreeEntry): string => {
  if (entry.branch !== "") return entry.branch.replace(/^refs\/heads\//, "");
  if (entry.detached) {
    return entry.head.length >= 7 ? entry.head.slice(0, 7) : "detached";
  }
  return UNKNOWN_BRANCH;
};

// Which listed checkout is the project's primary, none for a bare repo,
// whose checkouts are all linked worktrees (crowning one would make it
// unremovable). The checkout at the project path wherever git lists it,
// else the first.
const primaryCheckoutPath = (
  entries: ReadonlyArray<WorktreeEntry>,
  projectPath: string,
): string | undefined => {
  if (entries.some((entry) => entry.bare)) return undefined;
  return (
    entries.find((entry) => entry.path === projectPath)?.path ??
    entries[0]?.path
  );
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));

// A leaf that only repeats the repo's folder name (the Codex layout)
// takes its parent's name instead, when that passes as a folder name.
const externalWorktreeName = (worktreePath: string, projectPath: string) => {
  const leaf = basename(worktreePath);
  if (
    leaf.toLowerCase() !==
    basename(projectPath)
      .replace(/\.git$/, "")
      .toLowerCase()
  ) {
    return leaf;
  }
  const parent = basename(dirname(worktreePath));
  return isValidWorktreeDirName(parent) ? parent : leaf;
};

export const isPrimaryKeyword = (name: string) =>
  ["root", "primary"].includes(name.toLowerCase());

// A ref meant as a path. Names come from a directory's basename, so
// never hold a separator.
const looksLikePath = (ref: string) =>
  ref.includes("/") || ref.includes("\\") || ref === "." || ref === "..";

const primaryFirst = <A extends { readonly isPrimary: boolean }>(
  items: ReadonlyArray<A>,
): A[] => [
  ...items.filter((item) => item.isPrimary),
  ...items.filter((item) => !item.isPrimary),
];

// The primary checkout and the managed worktrees keep data; a checkout
// outside the layout keeps none.
const hasWorktreeData = (worktree: WorktreeIdentity) =>
  !worktree.isExternal || worktree.isPrimary;

const RECENT_COMMITS = 4;

// Each row starts five gits, and the app lists every project at once,
// so rows are built a few at a time.
const ROW_SLOTS = 6;

// Only managed worktrees carry the shelved mark: the primary checkout
// and externals never do.
const isShelved = (worktree: WorktreeIdentity, shelved: ReadonlySet<string>) =>
  !worktree.isPrimary && !worktree.isExternal && shelved.has(worktree.id);

// Each project's rows, a project git can't list skipped.
const across = <A>(
  projects: ReadonlyArray<RegisteredProject>,
  rows: (
    project: RegisteredProject,
  ) => Effect.Effect<ReadonlyArray<A>, Git.GitError>,
) =>
  Effect.forEach(projects, (project) => Effect.result(rows(project)), {
    concurrency: "unbounded",
  }).pipe(
    Effect.map((results) => ({
      rows: results.flatMap((result) =>
        Result.isSuccess(result) ? result.success : [],
      ),
      skipped: results.flatMap((result, index) =>
        Result.isFailure(result)
          ? [
              {
                project: projects[index] as RegisteredProject,
                error: result.failure,
              },
            ]
          : [],
      ),
    })),
  );

// --- make -----------------------------------------------------------------

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const github = yield* GitHub.GitHub;
  const config = yield* Config.Config;
  const layout = yield* Layout.Layout;
  const registry = yield* Registry.Registry;
  const data = yield* WorktreeData.WorktreeData;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* Paths.Paths;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  // The terminal binary's name, which the hints name.
  const binary = paths.dataDirName === ".sm" ? "sm" : "smd";

  const deviceFlag = (key: string) =>
    config.get({ kind: "device" }, key).pipe(
      Effect.map((setting) => setting.value === true),
      Effect.orElseSucceed(() => false),
    );

  // The project's settings, which count only once it is configured
  // (it has a default branch).
  const projectSettings = (project: RegisteredProject) =>
    config
      .read({ kind: "project", projectId: project.id, path: project.path })
      .pipe(
        Effect.map((doc) =>
          doc !== null &&
          typeof doc["defaultBranch"] === "string" &&
          doc["defaultBranch"].trim() !== ""
            ? doc
            : null,
        ),
      );

  const identities = Effect.fn("Worktrees.identities")(function* (
    project: RegisteredProject,
  ) {
    const entries = yield* git.listWorktrees(project.path);
    const bases = yield* layout.managedBases(project);
    const codexNames = yield* Effect.cached(deviceFlag("codexWorktreeNames"));
    const primaryPath = primaryCheckoutPath(entries, project.path);
    const found: WorktreeIdentity[] = [];
    for (const entry of entries) {
      if (entry.bare) continue;
      const isPrimary = entry.path === primaryPath;
      const isExternal = !isManagedPath(entry.path, bases);
      // The primary keeps its folder's name.
      const name =
        isExternal && !isPrimary && (yield* codexNames)
          ? externalWorktreeName(entry.path, project.path)
          : basename(entry.path);
      found.push({
        id: worktreeIdFromPath(entry.path),
        projectId: project.id,
        name,
        branch: deriveBranch(entry),
        path: entry.path,
        isPrimary,
        isExternal,
        detached: entry.detached,
        locked: entry.locked,
      });
    }
    return found;
  });

  // The project's primary ref, the default-branch setting honored, and
  // its remotes alongside.
  const primaryRefOf = Effect.fn(function* (project: RegisteredProject) {
    const remotes = yield* git.listRemotes(project.path);
    const settings = yield* projectSettings(project);
    const override =
      typeof settings?.["defaultBranch"] === "string"
        ? settings["defaultBranch"]
        : undefined;
    const primaryRef = Option.getOrElse(
      yield* git.resolveDefaultBranch(project.path, override, remotes),
      () => "",
    );
    // The ref's local branch: "main" for "origin/main".
    const primaryBranch =
      splitRemoteRef(primaryRef, remotes)?.branch ?? primaryRef;
    return { remotes, primaryRef, primaryBranch, settings };
  });

  const marks = Effect.all({
    shelved: registry.marked("shelved"),
    autoPull: registry.marked("autoPull"),
  });

  // What every row of one project is built against, read once.
  const contextOf = Effect.fn(function* (project: RegisteredProject) {
    const primary = yield* primaryRefOf(project);
    const marked = yield* marks;
    const chain = yield* Effect.cached(
      git.firstParentChain(project.path, primary.primaryRef),
    );
    return { project, ...primary, ...marked, chain };
  });
  type RowContext = Effect.Success<ReturnType<typeof contextOf>>;

  // When the linked worktree was added, epoch ms: the mtime of its admin
  // dir's commondir file, which `git worktree add` writes once. Zero for
  // the primary checkout, whose .git is a directory.
  const adminDirOf = (worktreePath: string) =>
    fs.readFileString(path.join(worktreePath, ".git")).pipe(
      Effect.map((text) => {
        const trimmed = text.trim();
        if (!trimmed.startsWith("gitdir: ")) return Option.none<string>();
        const dir = trimmed.slice("gitdir: ".length);
        return Option.some(
          path.isAbsolute(dir) ? dir : path.join(worktreePath, dir),
        );
      }),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const createdAtOf = (worktreePath: string) =>
    Effect.gen(function* () {
      const admin = yield* adminDirOf(worktreePath);
      if (Option.isNone(admin)) return 0;
      const info = yield* fs.stat(path.join(admin.value, "commondir"));
      return Math.max(
        Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        }),
        0,
      );
    }).pipe(Effect.orElseSucceed(() => 0));

  const descriptionOf = (worktree: WorktreeIdentity) =>
    hasWorktreeData(worktree)
      ? data.description(worktree.projectId, worktree.id)
      : Effect.succeed({ title: "", description: "", describedAt: 0 });

  // A row, and what the shelf needs of its probes: when they started,
  // and whether the status answered (a failed one shows as 0 changes,
  // which the shelf must not compare).
  const probe = (worktree: WorktreeIdentity, context: RowContext) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const relation =
        context.primaryRef === "" || worktree.isPrimary || worktree.detached
          ? Effect.succeed({ behindPrimary: 0, mergedIntoPrimary: false })
          : git.primaryRelation({
              worktree: worktree.path,
              primaryRef: context.primaryRef,
              chain: context.chain,
            });
      const probes = yield* Effect.all(
        {
          changes: Effect.result(git.workingTreeChanges(worktree.path)),
          commits: git.listCommits(worktree.path, {
            skip: 0,
            count: RECENT_COMMITS,
          }),
          sync: git.upstreamSync(worktree.path),
          relation,
          unpushed: git.unpushedCount(worktree.path),
          createdAt: createdAtOf(worktree.path),
          described: descriptionOf(worktree),
        },
        { concurrency: "unbounded" },
      );
      const changes = Result.getOrElse(probes.changes, () => ({
        count: 0,
        lastChangeAt: 0,
      }));
      const { title, description } = probes.described;
      const row: WorktreeRow = {
        id: worktree.id,
        projectId: worktree.projectId,
        name: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        ahead: probes.sync.ahead,
        behind: probes.sync.behind,
        hasUpstream: probes.sync.hasUpstream,
        hasRemote: context.remotes.length > 0,
        divergedClean: probes.sync.divergedClean,
        behindPrimary: probes.relation.behindPrimary,
        unpushedCount: probes.unpushed,
        ...(context.primaryRef === ""
          ? {}
          : { primaryRef: context.primaryRef }),
        ...(context.primaryBranch === ""
          ? {}
          : { primaryBranch: context.primaryBranch }),
        mergedIntoPrimary: probes.relation.mergedIntoPrimary,
        changedCount: changes.count,
        ...(changes.lastChangeAt === 0
          ? {}
          : { lastChangeAt: changes.lastChangeAt }),
        ...(probes.createdAt === 0 ? {} : { createdAt: probes.createdAt }),
        recentCommits: probes.commits,
        isPrimary: worktree.isPrimary,
        isExternal: worktree.isExternal,
        detached: worktree.detached,
        shelved: isShelved(worktree, context.shelved),
        // Unlike the shelf, any checkout can follow its upstream.
        autoPull: context.autoPull.has(worktree.id),
        ...(title === "" ? {} : { title }),
        ...(description === "" ? {} : { description }),
        projectName: context.project.name,
      };
      return { row, at, statusOk: Result.isSuccess(probes.changes) };
    });
  type Probed = Effect.Success<ReturnType<typeof probe>>;

  // Settles every shelved row of one listing in one transaction: a row
  // without a snapshot gets one, and one worked in since comes back
  // unshelved. The listing read the marks before its probes and acts
  // after them, so each write checks again: a shelve or unshelve in
  // between (which drops the snapshot) wins over the listing's stale
  // view. A seed lands only while the worktree is still marked and has
  // none, a retire only while the snapshot is the one compared against.
  const settle = (probed: ReadonlyArray<Probed>) =>
    Effect.gen(function* () {
      const shelved = probed.filter(
        ({ row, statusOk }) => row.shelved && statusOk,
      );
      if (shelved.length === 0) return probed.map(({ row }) => row);
      const stored = new Map(
        (yield* sql<ShelfSnapshot & { worktree_id: string }>`
          SELECT worktree_id, at, head, changed FROM shelf_snapshots
          WHERE ${sql.in(
            "worktree_id",
            shelved.map(({ row }) => row.id),
          )}`).map(({ worktree_id, ...snapshot }) => [worktree_id, snapshot]),
      );
      const seeds: Array<[string, ShelfSnapshot]> = [];
      const retires: Array<[string, number]> = [];
      for (const { row, at } of shelved) {
        const seen: ShelfObservation = {
          at,
          head: row.recentCommits[0]?.hash ?? "",
          changed: row.changedCount,
          lastChangeAt: row.lastChangeAt ?? 0,
          followsUpstream: row.autoPull && row.unpushedCount === 0,
        };
        const snapshot = stored.get(row.id);
        if (snapshot === undefined) seeds.push([row.id, snapshotOf(seen)]);
        else if (shelfWorked(snapshot, seen))
          retires.push([row.id, snapshot.at]);
      }
      if (seeds.length === 0 && retires.length === 0) {
        return probed.map(({ row }) => row);
      }
      const unshelved = new Set<string>();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const [id, { at, head, changed }] of seeds) {
            yield* sql`INSERT INTO shelf_snapshots (worktree_id, at, head, changed)
              SELECT ${id}, ${at}, ${head}, ${changed}
              WHERE EXISTS (SELECT 1 FROM worktree_marks
                WHERE worktree_id = ${id} AND mark = 'shelved')
              ON CONFLICT (worktree_id) DO NOTHING`;
          }
          for (const [id, at] of retires) {
            const retired = yield* sql`DELETE FROM shelf_snapshots
              WHERE worktree_id = ${id} AND at = ${at} RETURNING worktree_id`;
            if (retired.length === 0) continue;
            yield* sql`DELETE FROM worktree_marks
              WHERE worktree_id = ${id} AND mark = 'shelved'`;
            unshelved.add(id);
          }
        }),
      );
      return probed.map(({ row }) =>
        unshelved.has(row.id)
          ? Object.assign({}, row, { shelved: false })
          : row,
      );
    }).pipe(
      // A failed write leaves every row shelved: the next listing tries
      // again.
      Effect.catchTags({
        SqlError: () => Effect.succeed(probed.map(({ row }) => row)),
      }),
    );

  const rowsOf = Effect.fn("Worktrees.rowsOf")(function* (
    project: RegisteredProject,
  ) {
    const found = yield* identities(project);
    const context = yield* contextOf(project);
    const probed = yield* Effect.forEach(
      primaryFirst(found),
      (worktree) => probe(worktree, context),
      { concurrency: ROW_SLOTS },
    );
    return yield* settle(probed);
  });

  const list = Effect.fn("Worktrees.list")(function* (
    projects: ReadonlyArray<RegisteredProject>,
  ) {
    return yield* across(projects, rowsOf);
  });

  const row = Effect.fn("Worktrees.row")(function* (
    located: Located,
    options: { readonly settle?: boolean } = {},
  ) {
    const context = yield* contextOf(located.project);
    const probed = yield* probe(located.worktree, context);
    if (!options.settle) return probed.row;
    const [settled] = yield* settle([probed]);
    return settled ?? probed.row;
  });

  const identityRowsOf = (
    project: RegisteredProject,
    found: ReadonlyArray<WorktreeIdentity>,
    withPrimaryRef: boolean,
    marked: Effect.Success<typeof marks>,
  ) =>
    Effect.gen(function* () {
      const primary = withPrimaryRef
        ? yield* primaryRefOf(project)
        : { primaryRef: "", primaryBranch: "" };
      // The project's primary ref, the same on every row.
      const refs = {
        ...(primary.primaryRef === ""
          ? {}
          : { primaryRef: primary.primaryRef }),
        ...(primary.primaryBranch === ""
          ? {}
          : { primaryBranch: primary.primaryBranch }),
      };
      return primaryFirst(found).map(
        (worktree): IdentityRow =>
          Object.assign(
            {
              id: worktree.id,
              projectId: worktree.projectId,
              name: worktree.name,
              branch: worktree.branch,
              path: worktree.path,
              isPrimary: worktree.isPrimary,
              isExternal: worktree.isExternal,
              detached: worktree.detached,
              shelved: isShelved(worktree, marked.shelved),
              autoPull: marked.autoPull.has(worktree.id),
            },
            refs,
          ),
      );
    });

  const identityList = Effect.fn("Worktrees.identityList")(function* (
    projects: ReadonlyArray<RegisteredProject>,
    options: { readonly primaryRef: boolean },
  ) {
    const marked = yield* marks;
    return yield* across(projects, (project) =>
      identities(project).pipe(
        Effect.flatMap((found) =>
          identityRowsOf(project, found, options.primaryRef, marked),
        ),
      ),
    );
  });

  const identityRow = Effect.fn("Worktrees.identityRow")(function* (
    located: Located,
    options: { readonly primaryRef: boolean },
  ) {
    const [only] = yield* identityRowsOf(
      located.project,
      [located.worktree],
      options.primaryRef,
      yield* marks,
    );
    return only as IdentityRow;
  });

  // --- the status card ---

  const changeCounts = (worktree: string) =>
    git.status(worktree).pipe(
      Effect.map((files) => {
        const counts = {
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
          changedCount: files.length,
        };
        for (const file of files) {
          if (isUntracked(file)) counts.untracked++;
          else if (file.conflicted) counts.conflicted++;
          else {
            if (file.staged !== "none") counts.staged++;
            if (file.staged !== "all") counts.unstaged++;
          }
        }
        return counts;
      }),
      Effect.orElseSucceed(() => ({
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        changedCount: 0,
      })),
    );

  const stashCount = (worktree: string) =>
    git.run(worktree, ["stash", "list"]).pipe(
      Effect.map(
        (stdout) =>
          stdout.split("\n").filter((line) => line.trim() !== "").length,
      ),
      Effect.orElseSucceed(() => 0),
    );

  const readOptional = (file: string) =>
    fs
      .readFileString(file)
      .pipe(Effect.option, Effect.map(Option.getOrUndefined));

  // The ports port-pool provisioned here, and whether it is set up.
  const portsOf = (worktree: string) =>
    Effect.gen(function* () {
      const pool = parsePortPoolConfig(
        yield* readOptional(path.join(worktree, PORT_POOL_CONFIG)),
      );
      const files = new Map<string, string>();
      for (const name of Object.keys(pool.envFiles)) {
        const content = yield* readOptional(path.join(worktree, name));
        if (content !== undefined) files.set(name, content);
      }
      const [enabled, installed] = yield* Effect.all([
        deviceFlag("portPool"),
        findExecutable("port-pool").pipe(
          Effect.map(Option.isSome),
          Effect.provideContext(platform),
        ),
      ]);
      return {
        ports: matchPorts(pool, files),
        portPool: { enabled, installed, configured: pool.configured },
      };
    });

  const status = Effect.fn("Worktrees.status")(function* (
    located: Located,
    options: { readonly pullRequest: boolean },
  ) {
    const { project, worktree } = located;
    const lookup: Effect.Effect<
      GitHub.Lookup<GitHub.PullRequestCard> & { readonly skipped?: true }
    > = !options.pullRequest
      ? Effect.succeed({ found: null, skipped: true as const })
      : worktree.detached || worktree.branch === UNKNOWN_BRANCH
        ? Effect.succeed({ found: null, unavailable: "no branch to look up" })
        : github.cardFor(project.path, worktree.branch);
    const probes = yield* Effect.all(
      {
        pr: lookup,
        described: descriptionOf(worktree),
        counts: changeCounts(worktree.path),
        stashes: stashCount(worktree.path),
        commits: git.listCommits(worktree.path, { skip: 0, count: 1 }),
        upstream: git.upstreamSync(worktree.path),
        context: Effect.all({
          primary: primaryRefOf(project),
          marked: marks,
        }),
        ports: portsOf(worktree.path),
      },
      { concurrency: "unbounded" },
    );
    const { primary, marked } = probes.context;
    const base = Option.map(
      yield* git.aheadBehind(worktree.path, primary.primaryRef),
      (sync) => ({ ref: primary.primaryRef, ...sync }),
    );
    const { title, description } = probes.described;
    const scripts = primary.settings?.["scripts"];
    const script = (key: "setup" | "teardown") => {
      const value =
        typeof scripts === "object" && scripts !== null
          ? (scripts as Record<string, unknown>)[key]
          : undefined;
      return typeof value === "string" && value !== "" ? { [key]: value } : {};
    };
    return {
      id: worktree.id,
      projectId: worktree.projectId,
      projectName: project.name,
      name: worktree.name,
      branch: worktree.branch,
      path: worktree.path,
      isPrimary: worktree.isPrimary,
      isExternal: worktree.isExternal,
      detached: worktree.detached,
      shelved: isShelved(worktree, marked.shelved),
      ...(title === "" ? {} : { title }),
      ...(description === "" ? {} : { description }),
      git: {
        upstream: probes.upstream.hasUpstream
          ? { ahead: probes.upstream.ahead, behind: probes.upstream.behind }
          : null,
        base: Option.getOrNull(base),
        ...probes.counts,
        stashCount: probes.stashes,
        lastCommit: probes.commits[0] ?? null,
      },
      ...probes.ports,
      scripts: { ...script("setup"), ...script("teardown") },
      pr: probes.pr.found,
      ...(probes.pr.found === null && probes.pr.unavailable !== undefined
        ? { prUnavailable: probes.pr.unavailable }
        : {}),
      ...(probes.pr.skipped ? { prSkipped: true as const } : {}),
      autoPull: marked.autoPull.has(worktree.id),
      ...(primary.primaryBranch === ""
        ? {}
        : { primaryBranch: primary.primaryBranch }),
    } satisfies StatusCard;
  });

  // --- finding the worktree ---

  const targetError = (
    here: Here,
    reason: TargetError["reason"],
    ref = "",
    matches: ReadonlyArray<string> = [],
  ) =>
    new TargetError({
      reason,
      ref,
      matches: [...matches],
      projects: here.projects.map((project) => project.name),
      binary,
    });

  // The worktree's root and its repository's primary checkout, from one
  // git: the common dir points at the primary's .git even from a linked
  // worktree.
  const locateRepo = (dir: string) =>
    git
      .run(dir, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ])
      .pipe(
        Effect.map((stdout) => {
          const [toplevel, commonDir] = stdout.trim().split("\n");
          if (toplevel === undefined || commonDir === undefined) {
            return Option.none();
          }
          const common = commonDir.trim();
          return Option.some({
            toplevel: toplevel.trim(),
            primaryPath: basename(common) === ".git" ? dirname(common) : common,
          });
        }),
        Effect.orElseSucceed(() => Option.none()),
      );

  // The worktree at `toplevel` among the projects whose primary is
  // `primaryPath`. `owned` tells "not a registered repo" from
  // "registered, but its worktrees unreadable".
  const worktreeAt = (
    projects: ReadonlyArray<RegisteredProject>,
    toplevel: string,
    primaryPath: string,
  ) =>
    Effect.gen(function* () {
      let owned = false;
      for (const project of projects) {
        if (project.path !== primaryPath) continue;
        owned = true;
        const found = yield* identities(project).pipe(Effect.option);
        if (Option.isNone(found)) continue;
        const worktree = found.value.find((id) => id.path === toplevel);
        if (worktree) return { located: { project, worktree }, owned };
      }
      return { located: undefined, owned };
    });

  const locate = Effect.fn("Worktrees.here")(function* (cwd: string) {
    const projects = yield* registry.projects;
    const repo = yield* locateRepo(cwd);
    if (Option.isNone(repo)) {
      return { cwd, projects, current: undefined, unregisteredRepo: undefined };
    }
    const { located, owned } = yield* worktreeAt(
      projects,
      repo.value.toplevel,
      repo.value.primaryPath,
    );
    return {
      cwd,
      projects,
      current: located,
      unregisteredRepo: located || owned ? undefined : repo.value.toplevel,
    };
  });

  // A typed path made absolute against the command's cwd, ~ expanded.
  const absolute = (here: Here, ref: string) => {
    const expanded =
      ref === "~"
        ? paths.home
        : ref.startsWith("~/")
          ? path.join(paths.home, ref.slice(2))
          : ref;
    return path.resolve(here.cwd, expanded);
  };

  const resolveProject = Effect.fn("Worktrees.resolveProject")(function* (
    here: Here,
    ref: string | undefined,
  ) {
    if (ref === undefined || ref === "") {
      if (here.current) return here.current.project;
      return yield* here.unregisteredRepo !== undefined
        ? targetError(here, "unregistered-project", here.unregisteredRepo)
        : targetError(here, "not-in-project");
    }
    // A path resolves against the registered paths, which are unique
    // where names are not: by string first, so an entry whose folder is
    // gone stays addressable, then by the repository it is inside.
    if (looksLikePath(ref)) {
      const abs = absolute(here, ref);
      const exact = here.projects.find((project) => project.path === abs);
      if (exact) return exact;
      const repo = yield* locateRepo(abs);
      const owner = Option.flatMapNullishOr(repo, ({ primaryPath }) =>
        here.projects.find((project) => project.path === primaryPath),
      );
      if (Option.isSome(owner)) return owner.value;
      return yield* targetError(here, "no-project-at", abs);
    }
    const named = here.projects.filter(
      (project) => project.name.toLowerCase() === ref.toLowerCase(),
    );
    if (named.length === 1) return named[0] as RegisteredProject;
    if (named.length > 1) {
      // Never guess: the path is how to say which.
      return yield* targetError(
        here,
        "ambiguous-project",
        ref,
        named.map((project) => project.path),
      );
    }
    // The id the app names it by works too. Names win.
    const byId = here.projects.find((project) => project.id === ref);
    if (byId) return byId;
    return yield* targetError(here, "unknown-project", ref);
  });

  const resolveProjectById = Effect.fn("Worktrees.resolveProjectById")(
    function* (here: Here, projectId: string) {
      const found = here.projects.find((project) => project.id === projectId);
      if (!found) return yield* new Registry.UnknownProject({ projectId });
      return found;
    },
  );

  const primaryOf = Effect.fn(function* (
    here: Here,
    project: RegisteredProject,
  ) {
    const worktree = (yield* identities(project)).find((id) => id.isPrimary);
    if (!worktree) return yield* targetError(here, "no-primary", project.name);
    return { project, worktree };
  });

  const resolve = Effect.fn("Worktrees.resolve")(function* (
    here: Here,
    target: Target,
  ) {
    if (target.worktreeId) {
      const scope = target.projectId
        ? [yield* resolveProjectById(here, target.projectId)]
        : here.projects;
      for (const project of scope) {
        const found = yield* identities(project).pipe(Effect.option);
        const worktree = Option.getOrUndefined(found)?.find(
          (id) => id.id === target.worktreeId,
        );
        if (worktree) return { project, worktree };
      }
      return yield* new UnknownWorktree({ worktreeId: target.worktreeId });
    }

    const ref = target.ref ?? "";
    if (ref === "") {
      // -p with no name targets that project, never whatever project
      // the cwd is in. A cwd inside the named project keeps its default.
      if (target.project) {
        const project = yield* resolveProject(here, target.project);
        if (here.current?.project.id !== project.id) {
          return yield* targetError(here, "name-in-project", project.name);
        }
      }
      if (here.current) return here.current;
      return yield* here.unregisteredRepo !== undefined
        ? targetError(here, "unregistered-worktree", here.unregisteredRepo)
        : targetError(here, "not-in-worktree");
    }

    // A ref that is a directory resolves by identity, not name, so
    // externals with colliding basenames stay addressable (`sm rm .`).
    if (looksLikePath(ref)) {
      const abs = absolute(here, ref);
      const isDirectory = yield* fs.stat(abs).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (isDirectory) {
        const repo = yield* locateRepo(abs);
        if (Option.isSome(repo)) {
          const { located } = yield* worktreeAt(
            here.projects,
            repo.value.toplevel,
            repo.value.primaryPath,
          );
          if (located) return located;
        }
        return yield* targetError(here, "not-a-worktree", abs);
      }
    }

    let scope = here.projects;
    let name = ref;
    if (target.project) {
      scope = [yield* resolveProject(here, target.project)];
    } else if (ref.includes("/")) {
      const cut = ref.indexOf("/");
      scope = [yield* resolveProject(here, ref.slice(0, cut))];
      name = ref.slice(cut + 1);
    }

    // The reserved names beat the name scan: a narrowed scope answers
    // directly, an unqualified one prefers the project at the cwd.
    if (isPrimaryKeyword(name)) {
      if (scope.length === 1)
        return yield* primaryOf(here, scope[0] as RegisteredProject);
      if (here.current) return yield* primaryOf(here, here.current.project);
      if (scope.length > 1) {
        return yield* targetError(here, "keyword-needs-project", name);
      }
    }

    const matches = (yield* Effect.forEach(
      scope,
      (project) =>
        identities(project).pipe(
          Effect.map((found) =>
            found
              .filter((id) => id.name.toLowerCase() === name.toLowerCase())
              .map((worktree) => ({ project, worktree })),
          ),
          // A missing or broken repo: the others can still match.
          Effect.orElseSucceed((): Located[] => []),
        ),
      { concurrency: "unbounded" },
    )).flat();
    if (matches.length === 1) return matches[0] as Located;
    if (matches.length === 0) {
      return yield* targetError(
        here,
        "no-such-worktree",
        name,
        scope.length === 1 ? [(scope[0] as RegisteredProject).name] : [],
      );
    }
    return yield* targetError(
      here,
      "ambiguous-worktree",
      name,
      matches.map(
        ({ project, worktree }) => `${project.name}/${worktree.name}`,
      ),
    );
  });

  // --- marks and descriptions ---

  const setShelved = Effect.fn("Worktrees.setShelved")(function* (
    worktree: WorktreeIdentity,
    on: boolean,
  ) {
    if (on && worktree.isPrimary) {
      return yield* new MarkRefused({ reason: "primary" });
    }
    if (on && worktree.isExternal) {
      return yield* new MarkRefused({ reason: "external" });
    }
    yield* registry.setMark("shelved", worktree.id, on);
  });

  const setAutoPull = Effect.fn("Worktrees.setAutoPull")(function* (
    worktree: WorktreeIdentity,
    on: boolean,
  ) {
    yield* registry.setMark("autoPull", worktree.id, on);
  });

  // The open pull request that owns the description: never one on the
  // primary branch, which a fork's branch of the same name would be.
  const owningPullRequest = Effect.fn(function* (located: Located) {
    const { project, worktree } = located;
    if (worktree.detached || worktree.branch === UNKNOWN_BRANCH) {
      return { found: null };
    }
    const primary = yield* primaryRefOf(project);
    if (
      primary.remotes.length === 0 ||
      worktree.branch === primary.primaryBranch
    ) {
      return { found: null };
    }
    return yield* github.owningPullRequest(project.path, worktree.branch);
  });

  const description = Effect.fn("Worktrees.description")(function* (
    located: Located,
  ) {
    if (!hasWorktreeData(located.worktree)) {
      return yield* new DescribeRefused({ reason: "external", binary });
    }
    const stored = yield* data.description(
      located.project.id,
      located.worktree.id,
    );
    const pr = yield* owningPullRequest(located);
    return {
      title: stored.title,
      description: stored.description,
      pullRequest: pr.found,
    };
  });

  const describe = Effect.fn("Worktrees.describe")(function* (
    located: Located,
    change: { readonly title?: string; readonly description?: string },
  ) {
    if (!hasWorktreeData(located.worktree)) {
      return yield* new DescribeRefused({ reason: "external", binary });
    }
    let { title, description: text } = change;
    if (title !== undefined) {
      title = title.trim();
      // oxlint-disable-next-line no-control-regex -- the control characters are the point
      if (/[\p{Cc}]/u.test(title)) {
        return yield* new DescribeRefused({ reason: "title-control", binary });
      }
      if ([...title].length > MAX_TITLE) {
        return yield* new DescribeRefused({ reason: "title-length", binary });
      }
    }
    if (text !== undefined) {
      // Blank lines and trailing space go. A first line's indentation
      // stays: in markdown it can make a code block.
      text = text.replace(/^[\r\n]+/, "").trimEnd();
      if ([...text].length > MAX_DESCRIPTION) {
        return yield* new DescribeRefused({
          reason: "description-length",
          binary,
        });
      }
    }
    // Last, once the input is known good: it asks GitHub.
    const pr = yield* owningPullRequest(located);
    if (pr.found !== null) {
      return yield* new PullRequestOwnsDescription({
        worktree: located.worktree.name,
        number: pr.found.number,
      });
    }
    yield* data.describe(located.project.id, located.worktree.id, {
      ...(title === undefined ? {} : { title }),
      ...(text === undefined ? {} : { description: text }),
    });
    return yield* row(located);
  });

  return Worktrees.of({
    identities,
    identityList,
    identityRow,
    list,
    row,
    status,
    here: locate,
    resolveProject,
    resolveProjectById,
    resolve,
    setShelved,
    setAutoPull,
    description,
    describe,
  });
});

export const layer = Layer.effect(Worktrees, make);
