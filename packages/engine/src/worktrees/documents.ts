// Worktrees' documents, errors and the pure helpers the areas share
// (EFFECT.md, section 2). `Worktrees.ts` re-exports what consumers use,
// so they import it from there.
import { isValidWorktreeDirName } from "@shigomori/contracts/predicates/worktreeDirName";
import type { CommitSummary } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type AgentSession, anyWorking } from "../agentSessions.ts";
import type { CarryOverReport, Source } from "../CarryOver.ts";
import type { CloneFailed, CloneReport } from "../CloneCheckout.ts";
import * as Git from "../Git.ts";
import * as GitHub from "../GitHub.ts";
import type { WorktreeEntry } from "../gitParse.ts";
import * as Lifecycle from "../Lifecycle.ts";
import { type PortInfo } from "../ports.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import type * as WorktreeData from "../WorktreeData.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";

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
  // Whether a bound agent session is working (Agents.ts), and the
  // sessions themselves.
  readonly agentWorking: boolean;
  readonly agentSessions: ReadonlyArray<AgentSession>;
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
  readonly agentWorking: boolean;
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
  readonly agentWorking: boolean;
  readonly primaryBranch?: string;
};

// What `sm worktrees describe` shows: the worktree's own pair, beside
// the open pull request that takes their place when there is one.
export type DescriptionView = {
  readonly title: string;
  readonly description: string;
  readonly pullRequest: GitHub.OwningPullRequest | null;
  // Why the pull request couldn't be looked up, when that is worth a
  // word (a repository off GitHub isn't).
  readonly pullRequestUnavailable?: string;
};

// What a describe wrote: the worktree's own pair as stored, with why the
// pull request couldn't be looked up when that is worth a word, or the
// open pull request it edited instead, as it now reads.
export type Described =
  | {
      readonly described: WorktreeData.Description;
      readonly pullRequest: null;
      readonly pullRequestUnavailable?: string;
    }
  | {
      readonly described: null;
      readonly pullRequest: GitHub.OwningPullRequest;
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
  readonly projects: ReadonlyArray<Registry.ListedProject>;
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

// The worktree as `rm` and `land` report it removed.
export type Removed = {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly path: string;
  readonly projectName: string;
};

// Where a project's primary branch is, as primaryTarget reads it.
export type PrimaryTarget = {
  readonly remotes: ReadonlyArray<string>;
  readonly primaryRef: string;
  readonly remote: string;
  readonly primaryBranch: string;
};

// What making or removing a worktree reports as it goes, each event the
// document `sm --json` prints for it.
export type WorktreeEvent =
  | Lifecycle.LifecycleEvent
  | { readonly event: "carryOver"; readonly report: CarryOverReport }
  | { readonly event: "cloned"; readonly cloned: Cloned }
  | { readonly event: "created"; readonly worktree: WorktreeRow };

// Where the events go, and whether a script's output may be truecolor
// (it is shown in the app's console).
export type Reporter = {
  readonly report: (event: WorktreeEvent) => Effect.Effect<void>;
  readonly color: boolean;
};

// How a new worktree's files were cloned: from which checkout, and how
// the clone went or why it gave way to git's own checkout.
export type Cloned = {
  readonly from: Source;
  readonly outcome: Result.Result<CloneReport, CloneFailed>;
};

// A new worktree and the lifecycle scripts that failed on it.
export type Created = {
  readonly worktree: WorktreeRow;
  readonly failures: ReadonlyArray<Lifecycle.ScriptFailure>;
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

// What a command that can't tell the project says about the ones there
// are.
export const projectsHint = (names: ReadonlyArray<string>) =>
  names.length === 0
    ? "No projects are registered yet. Add the repo in the Shigoto no Mori app first."
    : `Registered projects: ${names.join(", ")}.`;

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
    const hint = projectsHint(this.projects);
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

// The shelf takes only a managed worktree, refusing the primary
// checkout or an external one.
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
export const MAX_TITLE = 256;
export const MAX_DESCRIPTION = 65536;

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

// A describe that takes the open pull request's title away: GitHub
// refuses a PR without one.
export class PullRequestNeedsTitle extends Schema.TaggedError<PullRequestNeedsTitle>()(
  "PullRequestNeedsTitle",
  { number: Schema.Int },
) {
  // The command line was wrong, not the worktree.
  get usage(): boolean {
    return true;
  }

  override get message(): string {
    return `PR #${this.number} needs a title.`;
  }
}

// A describe while gh couldn't tell whether the branch has an open pull
// request: a write it missed would sit hidden under the PR's text.
export class PullRequestUnchecked extends Schema.TaggedError<PullRequestUnchecked>()(
  "PullRequestUnchecked",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Couldn't check for a pull request (${this.reason}), so nothing was changed.`;
  }
}

// What `projects relocate` won't do: point a project that is still
// there, or one terrier lists, at another path.
export class RelocateRefused extends Schema.TaggedError<RelocateRefused>()(
  "RelocateRefused",
  {
    reason: Schema.Literals([
      "not-a-repo",
      "via-terrier",
      "still-there",
      "terrier-lists-old",
      "terrier-lists-new",
    ]),
    path: Schema.String,
    name: Schema.String,
    binary: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-repo":
        return `${this.path} is not a git repository`;
      case "via-terrier":
        return `${this.name} is registered via terrier, not ${this.binary}. Register its new path with terrier instead.`;
      case "still-there":
        return `${this.path} is still there. Relocate is for a repo that was moved or renamed by hand.`;
      case "terrier-lists-old":
        return `terrier still lists ${this.path}. Run \`terrier prune\` first, then relocate.`;
      case "terrier-lists-new":
        return `${this.path} is already a project, via terrier. Remove ${this.name} instead (\`${this.binary} projects remove ${this.name}\`).`;
    }
  }
}

// A worktree whose uncommitted changes would go with it, or whose status
// can't be read (which must not pass for clean). `verb` is the command
// that refused, `destroys` set when the changes would be lost with it.
export class DirtyWorktree extends Schema.TaggedError<DirtyWorktree>()(
  "DirtyWorktree",
  {
    reason: Schema.Literals(["uncommitted", "unreadable"]),
    count: Schema.Int,
    verb: Schema.String,
    destroys: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "unreadable") {
      const said = errorMessageOf(this.cause);
      return `Couldn't check for uncommitted changes (${said}). Fix the worktree, or pass --force to ${this.verb} anyway.`;
    }
    return this.destroys === ""
      ? `Worktree has ${this.count} uncommitted change(s). Pass --force to ${this.verb} anyway.`
      : `Worktree has ${this.count} uncommitted change(s) that ${this.destroys} would destroy. Commit them first, or pass --force.`;
  }
}

// What a worktree command won't do, the reason in its message.
export class WorktreeRefused extends Schema.TaggedError<WorktreeRefused>()(
  "WorktreeRefused",
  {
    reason: Schema.Literals([
      "reserved-name",
      "invalid-name",
      "name-taken",
      "destination-taken",
      "checkout-needs-base",
      "vanished",
      "remove-primary",
      "changed-during-cleanup",
      "uncommitted-at-remove",
      "invalid-branch",
      "invalid-base",
      "move-primary",
      "rename-primary",
      "move-destination-exists",
      "move-not-listed",
      "move-copy-failed",
      "move-in-progress",
      "adopt-primary",
      "adopt-managed",
    ]),
    // The name or path the refusal is about.
    subject: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The command line was what was wrong (the terminal exits 2).
  get usage(): boolean {
    return [
      "reserved-name",
      "invalid-name",
      "invalid-branch",
      "invalid-base",
    ].includes(this.reason);
  }

  override get message(): string {
    const quoted = JSON.stringify(this.subject);
    switch (this.reason) {
      case "reserved-name":
        return `${quoted} is reserved. It addresses the project's primary checkout.`;
      case "invalid-name":
        return `${quoted} is not a valid worktree folder name.`;
      case "name-taken":
        return `A worktree folder named "${this.subject}" already exists in this project.`;
      case "destination-taken":
        return `Destination already exists: ${this.subject} (another project with the same folder name may own it)`;
      case "checkout-needs-base":
        return "Checkout mode requires a base ref";
      case "vanished":
        return "worktree disappeared after creation";
      case "remove-primary":
        return "Cannot delete the project's primary worktree";
      case "changed-during-cleanup":
        return `Changes appeared in ${this.subject} while its cleanup scripts ran, so it was kept. Remove them, or pass --force --skip-cleanup to remove it without running the scripts again.`;
      case "uncommitted-at-remove":
        return `Worktree ${this.subject} has uncommitted changes. Pass --force to remove anyway.`;
      case "invalid-branch":
        return `Invalid --branch: ${quoted} is not a valid git ref name.`;
      case "invalid-base":
        return `Invalid --base: ${quoted} is not a valid git ref name.`;
      case "move-primary":
        return "The primary checkout can't be moved";
      case "rename-primary":
        return "The primary checkout keeps its folder's name";
      case "move-destination-exists":
        return `Destination already exists: ${this.subject}`;
      case "move-not-listed":
        return `git doesn't list a worktree at ${this.subject} after the move`;
      case "move-copy-failed": {
        const said = errorMessageOf(this.cause);
        return `Couldn't copy the worktree to ${this.subject}: ${said}`;
      }
      case "move-in-progress":
        return `${this.subject} is already being moved. Wait for it, or run \`doctor --fix\` if that move's process is gone.`;
      case "adopt-primary":
        return "The primary checkout can't be converted";
      case "adopt-managed":
        return "Worktree is already shigomori-managed";
    }
  }
}

// What a failed cleanup says, the error's and the document's alike.
export const cleanupFailureWords = (failure: {
  readonly phase: string;
  readonly exitCode: number | null;
}) =>
  `${failure.phase} ${failure.exitCode === null ? "failed to run" : `exited with code ${failure.exitCode}`}; worktree not removed`;

// A cleanup script that failed during a removal, which left the worktree
// in place. The run id ties the failure to the script's output.
export class CleanupFailed extends Schema.TaggedError<CleanupFailed>()(
  "CleanupFailed",
  {
    phase: Schema.Literals(["portPoolRelease", "teardown"]),
    exitCode: Schema.NullOr(Schema.Int),
    runId: Schema.String,
  },
) {
  override get message(): string {
    return cleanupFailureWords(this);
  }
}

// The document's account of a failed cleanup, which the app reads.
export const cleanupErrorOf = (error: CleanupFailed) => ({
  phase: error.phase,
  exitCode: error.exitCode,
  runId: error.runId,
});

// A removal git finished on its side (its admin entry is gone) whose
// checkout is still on disk because the sweep after it failed.
export class OrphanedWorktree extends Schema.TaggedError<OrphanedWorktree>()(
  "OrphanedWorktree",
  { path: Schema.String, git: Schema.String, wipe: Schema.String },
) {
  override get message(): string {
    return `git no longer tracks ${this.path} as a worktree but couldn't finish deleting it (git: ${this.git}. wipe: ${this.wipe}). Delete the directory by hand.`;
  }
}

// --- helpers --------------------------------------------------------------

export const deriveBranch = (entry: WorktreeEntry): string => {
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
export const primaryCheckoutPath = (
  entries: ReadonlyArray<WorktreeEntry>,
  projectPath: string,
): string | undefined => {
  if (entries.some((entry) => entry.bare)) return undefined;
  return (
    entries.find((entry) => entry.path === projectPath)?.path ??
    entries[0]?.path
  );
};

// A leaf that only repeats the repo's folder name (the Codex layout)
// takes its parent's name instead, when that passes as a folder name.
export const externalWorktreeName = (
  path: Path.Path,
  worktreePath: string,
  projectPath: string,
) => {
  const leaf = path.basename(worktreePath);
  if (leaf.toLowerCase() !== path.basename(projectPath, ".git").toLowerCase()) {
    return leaf;
  }
  const parent = path.basename(path.dirname(worktreePath));
  return isValidWorktreeDirName(parent) ? parent : leaf;
};

// What Go's unicode.IsSpace calls space, which its TrimSpace trims.
// JavaScript's trim differs at the edges: it keeps U+0085 and drops
// U+FEFF.
const GO_SPACE_START =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
export const GO_SPACE_END =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;
export const trimGoSpace = (text: string) =>
  text.replace(GO_SPACE_START, "").replace(GO_SPACE_END, "");

// `{ [key]: value }`, or nothing when the value is empty: the fields
// Go's omitempty leaves out.
export const nonEmpty = <K extends string, V extends string | number>(
  key: K,
  value: V,
) =>
  (value === "" || value === 0 ? {} : { [key]: value }) as {
    readonly [P in K]?: V;
  };

// A project's setup or teardown script, empty when it has none.
export const scriptOf = (
  settings: Readonly<Record<string, unknown>> | null,
  key: "setup" | "teardown",
) => {
  const scripts = settings?.["scripts"];
  const value = Predicate.isObject(scripts) ? scripts[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
};

export const NO_CHANGES = {
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  changedCount: 0,
};

export const isPrimaryKeyword = (name: string) =>
  ["root", "primary"].includes(name.toLowerCase());

// A ref meant as a path. Names come from a directory's basename, so
// never hold a separator.
export const looksLikePath = (ref: string) =>
  ref.includes("/") || ref.includes("\\") || ref === "." || ref === "..";

export const primaryFirst = <A extends { readonly isPrimary: boolean }>(
  items: ReadonlyArray<A>,
): A[] => [
  ...items.filter((item) => item.isPrimary),
  ...items.filter((item) => !item.isPrimary),
];

// The primary checkout and the managed worktrees keep data. A checkout
// outside the layout keeps none.
export const hasWorktreeData = (worktree: WorktreeIdentity) =>
  !worktree.isExternal || worktree.isPrimary;

export const RECENT_COMMITS = 4;

// Each row starts five gits, and the app lists every project at once,
// so rows are built a few at a time.
export const ROW_SLOTS = 6;

// Only managed worktrees are shelved and have agent sessions: the
// primary checkout and externals never do.
export const isShelfable = (worktree: WorktreeIdentity) =>
  !worktree.isPrimary && !worktree.isExternal;
export const isShelved = (
  worktree: WorktreeIdentity,
  shelved: ReadonlySet<string>,
) => isShelfable(worktree) && shelved.has(worktree.id);
export const sessionsOf = (
  worktree: WorktreeIdentity,
  marked: { readonly agentSessions: Registry.BoundSessions },
): ReadonlyArray<AgentSession> =>
  isShelfable(worktree) ? (marked.agentSessions.get(worktree.id) ?? []) : [];
export const isAgentWorking = (
  worktree: WorktreeIdentity,
  marked: { readonly agentSessions: Registry.BoundSessions },
) => anyWorking(sessionsOf(worktree, marked));

// Each project's rows, a project git can't list skipped.
export const across = <A>(
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

// The project's folder names, lowercased: what a new one must not
// collide with (case-insensitively, as the default volume is).
export const namesUsed = (found: ReadonlyArray<WorktreeIdentity>) =>
  new Set(found.map((worktree) => worktree.name.toLowerCase()));
