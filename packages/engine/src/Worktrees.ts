// A project's worktrees: which checkouts there are (their identities),
// what each one's row says (its sync, changes, commits and marks), the
// status card, finding the worktree a command means, and the marks and
// descriptions the app and agents set. The rows and documents keep the
// shapes `sm worktrees ... --json` prints, field for field.
import {
  isValidWorktreeDirName,
  sanitizeBranchForPath,
} from "@shigomori/contracts/predicates/worktreeDirName";
import type { LifecycleSlot } from "@shigomori/contracts/schemas/scripts";
import { isSafeRelPath } from "@shigomori/contracts/predicates/relPath";
import type { CommitSummary } from "@shigomori/contracts/schemas";
import type { ProjectRow } from "@shigomori/contracts/schemas/project";
import { isUntracked } from "@shigomori/contracts/schemas";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as CarryOver from "./CarryOver.ts";
import type { CarryOverReport } from "./CarryOver.ts";
import * as CloneCheckout from "./CloneCheckout.ts";
import type {
  CheckoutUnfinished,
  CloneFailed,
  CloneReport,
  CloneSource,
  HookFailed,
} from "./CloneCheckout.ts";
import * as Config from "./Config.ts";
import { findExecutable } from "./executables.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import type { WorktreeEntry } from "./gitParse.ts";
import { splitRemoteRef } from "./gitParse.ts";
import * as Layout from "./Layout.ts";
import * as Lifecycle from "./Lifecycle.ts";
import { shellQuote } from "./Lifecycle.ts";
import { copyTree, entryExists } from "./entries.ts";
import { pickWorktreeName } from "./names.ts";
import * as Paths from "./Paths.ts";
import { isNotFound } from "./platformErrors.ts";
import * as Terrier from "./Terrier.ts";
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
import {
  driveBaseOf,
  isManagedPath,
  worktreeIdFromPath,
} from "./worktreeLayout.ts";

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
  readonly agentWorking: boolean;
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
  readonly from: CloneSource;
  readonly outcome: Result.Result<CloneReport, CloneFailed>;
};

// A new worktree, the lifecycle scripts that failed on it, and how its
// files were cloned when they were.
export type Created = {
  readonly worktree: WorktreeRow;
  readonly failures: ReadonlyArray<Lifecycle.ScriptFailure>;
  readonly cloned?: Cloned | undefined;
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

// The marks only a managed worktree can carry, refused on the primary
// checkout or an external one.
export class MarkRefused extends Schema.TaggedError<MarkRefused>()(
  "MarkRefused",
  {
    mark: Schema.Literals(["shelved", "agentWorking"]),
    reason: Schema.Literals(["primary", "external"]),
  },
) {
  override get message(): string {
    const what =
      this.reason === "primary" ? "The primary checkout" : "External worktrees";
    return this.mark === "shelved"
      ? `${what} can't be shelved`
      : `${what} can't be marked as agent working`;
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
      const said =
        this.cause instanceof Error ? this.cause.message : String(this.cause);
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
      "move-primary",
      "move-destination-exists",
      "move-not-listed",
      "move-copy-failed",
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
    return this.reason === "reserved-name" || this.reason === "invalid-name";
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
      case "move-primary":
        return "The primary checkout can't be moved";
      case "move-destination-exists":
        return `Destination already exists: ${this.subject}`;
      case "move-not-listed":
        return `git doesn't list a worktree at ${this.subject} after the move`;
      case "move-copy-failed": {
        const said =
          this.cause instanceof Error ? this.cause.message : String(this.cause);
        return `Couldn't copy the worktree to ${this.subject}: ${said}`;
      }
      case "adopt-primary":
        return "The primary checkout can't be converted";
      case "adopt-managed":
        return "Worktree is already shigomori-managed";
    }
  }
}

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
    const detail =
      this.exitCode === null
        ? "failed to run"
        : `exited with code ${this.exitCode}`;
    return `${this.phase} ${detail}; worktree not removed`;
  }
}

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
    ) => Effect.Effect<Registry.ListedProject, TargetError>;
    readonly resolveProjectById: (
      here: Here,
      projectId: string,
    ) => Effect.Effect<Registry.ListedProject, Registry.UnknownProject>;
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
    // The mark an agent sets on a worktree it works in, and clears when
    // it hands the work back.
    readonly setAgentWorking: (
      worktree: WorktreeIdentity,
      on: boolean,
    ) => Effect.Effect<void, MarkRefused>;
    readonly description: (
      located: Located,
    ) => Effect.Effect<DescriptionView, DescribeRefused>;
    // Sets the title, the description, or both, and answers the row,
    // with why the pull request couldn't be looked up as `description`
    // says it.
    readonly describe: (
      located: Located,
      change: { readonly title?: string; readonly description?: string },
    ) => Effect.Effect<
      {
        readonly worktree: WorktreeRow;
        readonly pullRequestUnavailable?: string;
      },
      DescribeRefused | PullRequestOwnsDescription
    >;

    // Where a new worktree named `name` (picked when empty) would go,
    // and whether a worktree or anything else already sits there.
    readonly destination: (
      project: RegisteredProject,
      name: string,
    ) => Effect.Effect<
      { readonly name: string; readonly path: string; readonly taken: boolean },
      WorktreeRefused | Git.GitError
    >;
    // A new managed worktree on a new branch (`branch`, else its name)
    // from `base`, or with `checkout` on the existing branch `base`, then
    // carry-over and its setup.
    readonly create: (
      project: RegisteredProject,
      input: {
        readonly name?: string | undefined;
        readonly branch?: string | undefined;
        readonly base?: string | undefined;
        readonly checkout?: boolean | undefined;
        readonly skipSetup?: boolean | undefined;
        readonly agentWorking?: boolean | undefined;
        // Clone the files from an existing checkout where it can (the
        // default), instead of having git write them all.
        readonly clone?: boolean | undefined;
      },
      reporter: Reporter,
    ) => Effect.Effect<
      Created,
      WorktreeRefused | CheckoutUnfinished | HookFailed | Git.GitError
    >;
    // Makes an external worktree a managed one: its branch checked out
    // again under the layout, its marks and title carried, set up as a
    // new worktree is.
    readonly adopt: (
      located: Located,
      options: { readonly force: boolean },
      reporter: Reporter,
    ) => Effect.Effect<
      Created,
      | WorktreeRefused
      | DirtyWorktree
      | OrphanedWorktree
      | CheckoutUnfinished
      | HookFailed
      | Git.GitError
    >;
    // Runs the setup half of making a worktree again.
    readonly setup: (
      located: Located,
      reporter: Reporter,
    ) => Effect.Effect<{
      readonly ran: ReadonlyArray<string>;
      readonly failures: ReadonlyArray<Lifecycle.ScriptFailure>;
    }>;
    // Port-pool's release and the teardown script, the checkout, what is
    // kept under its id, and its branch when the device's setting says so.
    // `preflighted` skips the dirty check a caller already ran with
    // checkRemovable. The primary checkout is refused regardless.
    readonly remove: (
      located: Located,
      options: {
        readonly force: boolean;
        readonly keepBranch: boolean;
        readonly skipCleanup: boolean;
        readonly preflighted?: boolean;
      },
      reporter: Reporter,
    ) => Effect.Effect<
      Removed,
      | WorktreeRefused
      | DirtyWorktree
      | CleanupFailed
      | OrphanedWorktree
      | Git.GitError
    >;
    // The guards every removal shares: never the primary checkout, and no
    // uncommitted or unreadable worktree unless forced.
    readonly checkRemovable: (
      located: Located,
      force: boolean,
    ) => Effect.Effect<void, WorktreeRefused | DirtyWorktree>;
    // Moves the checkout to `destination` (absolute), across volumes too,
    // and carries what is kept under its id to the new one.
    readonly move: (
      located: Located,
      destination: string,
    ) => Effect.Effect<
      { readonly worktree: WorktreeRow; readonly previousId: string },
      WorktreeRefused | Git.GitError
    >;
    // The project's primary ref (the default-branch setting honored),
    // its remote and local branch when it is a remote-tracking ref, and
    // the remotes that resolved it. An empty ref when none resolves.
    readonly primaryTarget: (
      project: RegisteredProject,
    ) => Effect.Effect<PrimaryTarget>;
    // Carries what is kept under `from` to the id a checkout at `toPath`
    // (absolute) will have, ahead of moving it there. Answers that id.
    readonly rekey: (
      project: RegisteredProject,
      from: string,
      toPath: string,
    ) => Effect.Effect<string>;
    // Points a project whose repo was moved or renamed by hand at where
    // it is now (an absolute path, any folder inside it will do), keeping
    // its id. The
    // linked worktrees that moved along are re-linked, and the managed
    // ones a rename would leave external move to where new ones go.
    // Answers the project's row.
    readonly relocateProject: (
      project: Registry.ListedProject,
      destination: string,
    ) => Effect.Effect<
      ProjectRow,
      RelocateRefused | Registry.UnknownProject | Registry.ProjectPathTaken
    >;
    // The ids the shelf holds a snapshot for.
    readonly snapshotted: Effect.Effect<ReadonlySet<string>>;
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

// A leaf that only repeats the repo's folder name (the Codex layout)
// takes its parent's name instead, when that passes as a folder name.
const externalWorktreeName = (
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
const GO_SPACE_END =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;
const trimGoSpace = (text: string) =>
  text.replace(GO_SPACE_START, "").replace(GO_SPACE_END, "");

// `{ [key]: value }`, or nothing when the value is empty: the fields
// Go's omitempty leaves out.
const nonEmpty = <K extends string, V extends string | number>(
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

const NO_CHANGES = {
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
const looksLikePath = (ref: string) =>
  ref.includes("/") || ref.includes("\\") || ref === "." || ref === "..";

const primaryFirst = <A extends { readonly isPrimary: boolean }>(
  items: ReadonlyArray<A>,
): A[] => [
  ...items.filter((item) => item.isPrimary),
  ...items.filter((item) => !item.isPrimary),
];

// The primary checkout and the managed worktrees keep data. A checkout
// outside the layout keeps none.
const hasWorktreeData = (worktree: WorktreeIdentity) =>
  !worktree.isExternal || worktree.isPrimary;

const RECENT_COMMITS = 4;

// Each row starts five gits, and the app lists every project at once,
// so rows are built a few at a time.
const ROW_SLOTS = 6;

// Only managed worktrees carry the shelved and agent-working marks: the
// primary checkout and externals never do.
const isShelfable = (worktree: WorktreeIdentity) =>
  !worktree.isPrimary && !worktree.isExternal;
const isShelved = (worktree: WorktreeIdentity, shelved: ReadonlySet<string>) =>
  isShelfable(worktree) && shelved.has(worktree.id);
const isAgentWorking = (
  worktree: WorktreeIdentity,
  marked: { readonly agentWorking: ReadonlySet<string> },
) => isShelfable(worktree) && marked.agentWorking.has(worktree.id);

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

// The project's folder names, lowercased: what a new one must not
// collide with (case-insensitively, as the default volume is).
const namesUsed = (found: ReadonlyArray<WorktreeIdentity>) =>
  new Set(found.map((worktree) => worktree.name.toLowerCase()));

// A pending dirty-state capture of the worktree (`worktrees dirty`).
const dirtyRef = (worktreeId: string) => `refs/shigomori/dirty/${worktreeId}`;

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const lifecycle = yield* Lifecycle.Lifecycle;
  const carryOver = yield* CarryOver.CarryOver;
  const cloneCheckout = yield* CloneCheckout.CloneCheckout;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const github = yield* GitHub.GitHub;
  const config = yield* Config.Config;
  const layout = yield* Layout.Layout;
  const registry = yield* Registry.Registry;
  const terrier = yield* Terrier.Terrier;
  const data = yield* WorktreeData.WorktreeData;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* Paths.Paths;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const binary = paths.binaryName;

  const deviceFlag = (key: string) =>
    config.get({ kind: "device" }, key).pipe(
      Effect.map((setting) => setting.value === true),
      Effect.orElseSucceed(() => false),
    );

  // The project's settings and its default branch, which count only
  // once it is configured (it has one).
  const projectSettings = (project: RegisteredProject) =>
    config
      .read({ kind: "project", projectId: project.id, path: project.path })
      .pipe(Effect.map(Config.projectSettingsOf));

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
          ? externalWorktreeName(path, entry.path, project.path)
          : path.basename(entry.path);
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
    const [remotes, { settings, defaultBranch }] = yield* Effect.all(
      [git.listRemotes(project.path), projectSettings(project)],
      { concurrency: 2 },
    );
    const primaryRef = Option.getOrElse(
      yield* git.resolveDefaultBranch(project.path, defaultBranch, remotes),
      () => "",
    );
    // The ref's local branch: "main" for "origin/main".
    const primaryBranch =
      splitRemoteRef(primaryRef, remotes)?.branch ?? primaryRef;
    return { remotes, primaryRef, primaryBranch, settings };
  });

  // The marks, and with any worktree shelved the shelf's snapshots, read
  // before the probes: a snapshot taken after a row's probes started
  // must not be compared against them.
  const marks = Effect.gen(function* () {
    const [shelved, autoPull, agentWorking] = yield* Effect.all(
      [
        registry.marked("shelved"),
        registry.marked("autoPull"),
        registry.marked("agentWorking"),
      ],
      { concurrency: 3 },
    );
    const snapshots = new Map<string, ShelfSnapshot>(
      shelved.size === 0
        ? []
        : (yield* sql<ShelfSnapshot & { worktree_id: string }>`
            SELECT worktree_id, at, head, changed FROM shelf_snapshots`.pipe(
            Effect.orElseSucceed(() => []),
          )).map(({ worktree_id, ...snapshot }) => [worktree_id, snapshot]),
    );
    return { shelved, autoPull, agentWorking, snapshots };
  });

  // What every row of one project is built against, read once.
  const contextOf = Effect.fn(function* (
    project: RegisteredProject,
    marked: Effect.Success<typeof marks>,
  ) {
    const primary = yield* primaryRefOf(project);
    const chain = yield* Effect.cached(
      git.firstParentChain(project.path, primary.primaryRef),
    );
    return { project, ...primary, ...marked, chain };
  });
  type RowContext = Effect.Success<ReturnType<typeof contextOf>>;

  // When the linked worktree was added, epoch ms: the mtime of its admin
  // dir's commondir file, which `git worktree add` writes once. Zero for
  // the primary checkout, whose .git is a directory.
  const createdAtOf = (worktreePath: string) =>
    Effect.gen(function* () {
      const admin = yield* git.adminDirOf(worktreePath);
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
      : Effect.succeed(WorktreeData.NO_DESCRIPTION);

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
        ...nonEmpty("primaryRef", context.primaryRef),
        ...nonEmpty("primaryBranch", context.primaryBranch),
        mergedIntoPrimary: probes.relation.mergedIntoPrimary,
        changedCount: changes.count,
        ...nonEmpty("lastChangeAt", changes.lastChangeAt),
        ...nonEmpty("createdAt", probes.createdAt),
        recentCommits: probes.commits,
        isPrimary: worktree.isPrimary,
        isExternal: worktree.isExternal,
        detached: worktree.detached,
        shelved: isShelved(worktree, context.shelved),
        // Unlike the shelf, any checkout can follow its upstream.
        autoPull: context.autoPull.has(worktree.id),
        agentWorking: isAgentWorking(worktree, context),
        ...nonEmpty("title", title),
        ...nonEmpty("description", description),
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
  const settle = (
    probed: ReadonlyArray<Probed>,
    stored: ReadonlyMap<string, ShelfSnapshot>,
  ) => {
    const rows = probed.map(({ row }) => row);
    return Effect.gen(function* () {
      const shelved = probed.filter(
        ({ row, statusOk }) => row.shelved && statusOk,
      );
      if (shelved.length === 0) return rows;
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
      if (seeds.length === 0 && retires.length === 0) return rows;
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
      return rows.map((row) =>
        unshelved.has(row.id)
          ? Object.assign({}, row, { shelved: false })
          : row,
      );
    }).pipe(
      // A failed write leaves every row shelved: the next listing tries
      // again.
      Effect.catchTags({ SqlError: () => Effect.succeed(rows) }),
    );
  };

  const rowsOf = Effect.fn("Worktrees.rowsOf")(function* (
    project: RegisteredProject,
    marked: Effect.Success<typeof marks>,
  ) {
    const [found, context] = yield* Effect.all(
      [identities(project), contextOf(project, marked)],
      { concurrency: 2 },
    );
    const probed = yield* Effect.forEach(
      primaryFirst(found),
      (worktree) => probe(worktree, context),
      { concurrency: ROW_SLOTS },
    );
    return yield* settle(probed, context.snapshots);
  });

  const list = Effect.fn("Worktrees.list")(function* (
    projects: ReadonlyArray<RegisteredProject>,
  ) {
    const marked = yield* marks;
    return yield* across(projects, (project) => rowsOf(project, marked));
  });

  const row = Effect.fn("Worktrees.row")(function* (
    located: Located,
    options: { readonly settle?: boolean } = {},
  ) {
    const context = yield* contextOf(located.project, yield* marks);
    const probed = yield* probe(located.worktree, context);
    if (!options.settle) return probed.row;
    const [settled] = yield* settle([probed], context.snapshots);
    return settled ?? probed.row;
  });

  // The project's primary ref as the identity rows carry it, asked for
  // or not.
  const refsOf = (project: RegisteredProject, withPrimaryRef: boolean) =>
    withPrimaryRef
      ? primaryRefOf(project).pipe(
          Effect.map(({ primaryRef, primaryBranch }) => ({
            ...nonEmpty("primaryRef", primaryRef),
            ...nonEmpty("primaryBranch", primaryBranch),
          })),
        )
      : Effect.succeed({});

  const identityRowOf = (
    worktree: WorktreeIdentity,
    marked: Effect.Success<typeof marks>,
    refs: Pick<IdentityRow, "primaryRef" | "primaryBranch">,
  ): IdentityRow =>
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
        agentWorking: isAgentWorking(worktree, marked),
      },
      refs,
    );

  const identityList = Effect.fn("Worktrees.identityList")(function* (
    projects: ReadonlyArray<RegisteredProject>,
    options: { readonly primaryRef: boolean },
  ) {
    const marked = yield* marks;
    return yield* across(projects, (project) =>
      Effect.all([identities(project), refsOf(project, options.primaryRef)], {
        concurrency: 2,
      }).pipe(
        Effect.map(([found, refs]) =>
          primaryFirst(found).map((worktree) =>
            identityRowOf(worktree, marked, refs),
          ),
        ),
      ),
    );
  });

  const identityRow = Effect.fn("Worktrees.identityRow")(function* (
    located: Located,
    options: { readonly primaryRef: boolean },
  ) {
    return identityRowOf(
      located.worktree,
      yield* marks,
      yield* refsOf(located.project, options.primaryRef),
    );
  });

  // --- the status card ---

  const changeCounts = (worktree: string) =>
    git.status(worktree).pipe(
      Effect.map((files) => {
        const counts = { ...NO_CHANGES, changedCount: files.length };
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
      Effect.orElseSucceed(() => NO_CHANGES),
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
      const files = new Map(
        (yield* Effect.forEach(
          // A name that would leave the worktree is no env file of its.
          Object.keys(pool.envFiles).filter(isSafeRelPath),
          (name) =>
            readOptional(path.join(worktree, name)).pipe(
              Effect.map((content) => [name, content] as const),
            ),
          { concurrency: "unbounded" },
        )).flatMap(([name, content]) =>
          content === undefined ? [] : [[name, content] as const],
        ),
      );
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
        // The base divergence needs the primary ref, so it is asked
        // beside it.
        context: Effect.all(
          {
            primary: primaryRefOf(project).pipe(
              Effect.flatMap((primary) =>
                git.aheadBehind(worktree.path, primary.primaryRef).pipe(
                  Effect.map((base) => ({
                    ...primary,
                    base: Option.map(base, (sync) => ({
                      ref: primary.primaryRef,
                      ...sync,
                    })),
                  })),
                ),
              ),
            ),
            marked: marks,
          },
          { concurrency: 2 },
        ),
        ports: portsOf(worktree.path),
      },
      { concurrency: "unbounded" },
    );
    const { primary, marked } = probes.context;
    const { title, description } = probes.described;
    const scripts = primary.settings?.["scripts"];
    const script = (key: "setup" | "teardown") => {
      const value = Predicate.isObject(scripts) ? scripts[key] : undefined;
      return nonEmpty(key, typeof value === "string" ? value : "");
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
      ...nonEmpty("title", title),
      ...nonEmpty("description", description),
      git: {
        upstream: probes.upstream.hasUpstream
          ? { ahead: probes.upstream.ahead, behind: probes.upstream.behind }
          : null,
        base: Option.getOrNull(primary.base),
        ...probes.counts,
        stashCount: probes.stashes,
        lastCommit: probes.commits[0] ?? null,
      },
      ...probes.ports,
      scripts: { ...script("setup"), ...script("teardown") },
      pr: probes.pr.found,
      ...(probes.pr.found === null
        ? nonEmpty("prUnavailable", probes.pr.unavailable ?? "")
        : {}),
      ...(probes.pr.skipped ? { prSkipped: true as const } : {}),
      autoPull: marked.autoPull.has(worktree.id),
      agentWorking: isAgentWorking(worktree, marked),
      ...nonEmpty("primaryBranch", primary.primaryBranch),
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
    const projects = yield* registry.listed;
    const repo = yield* git.locate(cwd);
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
      const repo = yield* git.locate(abs);
      const owner = Option.flatMapNullishOr(repo, ({ primaryPath }) =>
        here.projects.find((project) => project.path === primaryPath),
      );
      if (Option.isSome(owner)) return owner.value;
      return yield* targetError(here, "no-project-at", abs);
    }
    const named = here.projects.filter(
      (project) => project.name.toLowerCase() === ref.toLowerCase(),
    );
    if (named.length === 1) return named[0] as Registry.ListedProject;
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
      // In order, stopping at the first: the app asks this on every
      // per-worktree call.
      for (const project of scope) {
        const listed = yield* identities(project).pipe(Effect.option);
        const worktree = Option.getOrUndefined(listed)?.find(
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
        const repo = yield* git.locate(abs);
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

  const refuseUnshelfable = (
    mark: MarkRefused["mark"],
    worktree: WorktreeIdentity,
    on: boolean,
  ) =>
    on && !isShelfable(worktree)
      ? Effect.fail(
          new MarkRefused({
            mark,
            reason: worktree.isPrimary ? "primary" : "external",
          }),
        )
      : Effect.void;

  const setShelved = Effect.fn("Worktrees.setShelved")(function* (
    worktree: WorktreeIdentity,
    on: boolean,
  ) {
    yield* refuseUnshelfable("shelved", worktree, on);
    yield* registry.setMark("shelved", worktree.id, on);
  });

  const setAutoPull = Effect.fn("Worktrees.setAutoPull")(function* (
    worktree: WorktreeIdentity,
    on: boolean,
  ) {
    yield* registry.setMark("autoPull", worktree.id, on);
  });

  const setAgentWorking = Effect.fn("Worktrees.setAgentWorking")(function* (
    worktree: WorktreeIdentity,
    on: boolean,
  ) {
    yield* refuseUnshelfable("agentWorking", worktree, on);
    yield* registry.setMark("agentWorking", worktree.id, on);
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
      ...(pr.unavailable === undefined
        ? {}
        : { pullRequestUnavailable: pr.unavailable }),
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
      title = trimGoSpace(title);
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
      text = text.replace(/^[\r\n]+/, "").replace(GO_SPACE_END, "");
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
    return {
      worktree: yield* row(located),
      ...(pr.unavailable === undefined
        ? {}
        : { pullRequestUnavailable: pr.unavailable }),
    };
  });

  // --- making and removing worktrees ---

  // A fresh folder name. It doubles as the branch name, so names a kept
  // local branch holds (a removed worktree's) are skipped too.
  const pickName = (project: RegisteredProject, used: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const taken = new Set(used);
      const refs = yield* git.branchRefs(project.path).pipe(Effect.option);
      for (const branch of Option.match(refs, {
        onNone: () => [],
        onSome: ({ locals }) => locals,
      })) {
        taken.add(branch.toLowerCase());
      }
      return yield* pickWorktreeName(taken, yield* deviceFlag("doubutsuNames"));
    });

  const checkName = (name: string) =>
    isPrimaryKeyword(name)
      ? Effect.fail(
          new WorktreeRefused({ reason: "reserved-name", subject: name }),
        )
      : name !== "" && !isValidWorktreeDirName(name)
        ? Effect.fail(
            new WorktreeRefused({ reason: "invalid-name", subject: name }),
          )
        : Effect.void;

  const occupied = (file: string) => entryExists(fs, file);

  const destination = Effect.fn("Worktrees.destination")(function* (
    project: RegisteredProject,
    requested: string,
  ) {
    const name = requested.trim();
    yield* checkName(name);
    const used = namesUsed(yield* identities(project));
    const picked = name === "" ? yield* pickName(project, used) : name;
    const place = path.join(yield* layout.worktreeBase(project), picked);
    const taken =
      (name !== "" && used.has(name.toLowerCase())) || (yield* occupied(place));
    return { name: picked, path: place, taken };
  });

  // What a script is told about the worktree it runs in.
  // `found` is the project's checkouts, when the caller has them.
  const scriptContext = (
    project: RegisteredProject,
    worktree: WorktreeIdentity,
    found?: ReadonlyArray<WorktreeIdentity>,
  ) =>
    Effect.gen(function* () {
      const [listed, primary, described] = yield* Effect.all(
        [
          found === undefined
            ? identities(project).pipe(
                Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []),
              )
            : Effect.succeed(found),
          primaryRefOf(project),
          descriptionOf(worktree),
        ],
        { concurrency: "unbounded" },
      );
      return {
        project,
        worktree,
        projectBranch: listed.find((id) => id.isPrimary)?.branch ?? "",
        defaultBranch: primary.primaryRef,
        title: described.title,
        description: described.description,
      };
    });

  const runScript = (
    context: Lifecycle.ScriptContext,
    reporter: Reporter,
    command: string,
    slot: LifecycleSlot,
  ) =>
    lifecycle.run({
      command,
      slot,
      context,
      color: reporter.color,
      report: reporter.report,
    });

  // Whether port-pool provisions and releases this worktree: the device
  // setting is on, port-pool is installed, the worktree is configured for
  // it, and the app made the worktree (no provision ever ran for an
  // external one, so none is released either).
  const portPoolActive = (worktree: WorktreeIdentity) =>
    Effect.gen(function* () {
      if (worktree.isExternal || !(yield* deviceFlag("portPool"))) return false;
      const installed = yield* findExecutable("port-pool").pipe(
        Effect.map(Option.isSome),
        Effect.provideContext(platform),
      );
      return (
        installed &&
        parsePortPoolConfig(
          yield* readOptional(path.join(worktree.path, PORT_POOL_CONFIG)),
        ).configured
      );
    });

  // The setup script, then port-pool's provision (never for an external
  // worktree, whose release never runs). Answers the failures and the
  // steps that ran. The caller reports the closing idle phase.
  const provision = (
    project: RegisteredProject,
    worktree: WorktreeIdentity,
    settings: Readonly<Record<string, unknown>> | null,
    skipSetup: boolean,
    reporter: Reporter,
    found?: ReadonlyArray<WorktreeIdentity>,
  ) =>
    Effect.gen(function* () {
      const failures: Lifecycle.ScriptFailure[] = [];
      const ran: string[] = [];
      const setup = skipSetup ? "" : scriptOf(settings, "setup");
      const pool = yield* portPoolActive(worktree);
      if (setup === "" && !pool) return { failures, ran };
      const context = yield* scriptContext(project, worktree, found);
      const step = (
        name: string,
        phase: Lifecycle.Phase,
        command: string,
        slot: LifecycleSlot,
      ) =>
        Effect.gen(function* () {
          yield* reporter.report({ event: "phase", phase });
          ran.push(name);
          const { code } = yield* runScript(context, reporter, command, slot);
          if (code !== 0) failures.push({ step: name, exitCode: code });
        });
      if (setup !== "") yield* step("setup", "setup", setup, { kind: "setup" });
      if (pool) {
        yield* step(
          "port-pool provision",
          "portPoolProvision",
          `port-pool provision ${shellQuote(worktree.path)}`,
          { kind: "portPool", phase: "provision" },
        );
      }
      return { failures, ran };
    });

  // What a new worktree goes through: carry-over, then the setup script
  // and port-pool's provision. `base` is the ref it was branched from,
  // which decides where carry-over looks first.
  const createLifecycle = (
    project: RegisteredProject,
    worktree: WorktreeIdentity,
    checkouts: ReadonlyArray<WorktreeIdentity>,
    base: string,
    skipSetup: boolean,
    reporter: Reporter,
  ) =>
    Effect.gen(function* () {
      const { settings } = yield* projectSettings(project);
      const carried = yield* carryOver.apply({
        repo: project.path,
        settings,
        checkouts,
        destination: worktree.path,
        base,
      });
      if (Option.isSome(carried)) {
        yield* reporter.report({ event: "phase", phase: "carryOver" });
        yield* reporter.report({ event: "carryOver", report: carried.value });
      }
      const { failures } = yield* provision(
        project,
        worktree,
        settings,
        skipSetup,
        reporter,
        checkouts,
      );
      yield* reporter.report({ event: "phase", phase: "idle" });
      return failures;
    });

  // The one way a worktree is made: the name checked or picked, the
  // layout's place, the base's remote ref refreshed, `git worktree add`,
  // and the identity git settled on. `checkout` puts the existing branch
  // `base` there (adopt's way) instead of making a new one. `clone`
  // clones the tracked files from an existing checkout where it can,
  // instead of having git write them all.
  const addWorktree = (
    project: RegisteredProject,
    input: {
      readonly name: string;
      readonly branch: string;
      readonly base: string;
      readonly checkout: boolean;
      readonly clone: boolean;
    },
  ) =>
    Effect.gen(function* () {
      if (input.checkout && input.base === "") {
        return yield* new WorktreeRefused({
          reason: "checkout-needs-base",
          subject: "",
        });
      }
      const existing = yield* identities(project);
      const used = namesUsed(existing);
      if (input.name !== "" && used.has(input.name.toLowerCase())) {
        return yield* new WorktreeRefused({
          reason: "name-taken",
          subject: input.name,
        });
      }
      const name =
        input.name === "" ? yield* pickName(project, used) : input.name;
      const place = path.join(yield* layout.worktreeBase(project), name);
      // The remote-tracking ref the worktree sits on, refreshed, so the
      // base isn't whatever the last fetch left.
      let remotes: ReadonlyArray<string> | undefined;
      if (
        input.base !== "" &&
        (yield* git.remoteRefExists(project.path, input.base))
      ) {
        remotes = yield* git.listRemotes(project.path);
        const split = splitRemoteRef(input.base, remotes);
        if (split) {
          yield* git
            .run(project.path, ["fetch", "--quiet", split.remote, split.branch])
            .pipe(Effect.ignore);
        }
      }
      // Projects that share a folder name share a base, so a sibling's
      // worktree can sit at the path.
      if (yield* occupied(place)) {
        return yield* new WorktreeRefused({
          reason: "destination-taken",
          subject: place,
        });
      }
      yield* fs
        .makeDirectory(path.dirname(place), { recursive: true })
        .pipe(Effect.orDie);
      // The checkout on the base branch, else the primary, else another:
      // where carry-over looks too.
      const source = input.clone
        ? yield* cloneCheckout.pickSource({
            repo: project.path,
            checkouts: existing,
            destination: place,
            baseBranch:
              input.base === ""
                ? ""
                : (yield* git.resolveCheckoutRef(
                    project.path,
                    input.base,
                    remotes,
                  )).target,
          })
        : Option.none<CloneSource>();
      const noCheckout = Option.isSome(source);
      // The branch the add makes: a new one, or in checkout mode the local
      // branch it tracks a remote base with.
      const branch = input.checkout
        ? Option.getOrElse(
            (yield* git.resolveCheckoutRef(project.path, input.base, remotes))
              .track,
            () => "",
          )
        : input.branch.trim() === ""
          ? name
          : input.branch.trim();
      if (input.checkout) {
        yield* git.checkoutWorktree({
          repo: project.path,
          path: place,
          ref: input.base,
          remotes,
          noCheckout,
        });
      } else {
        yield* git.addWorktree({
          repo: project.path,
          path: place,
          branch,
          base: input.base === "" ? undefined : input.base,
          noCheckout,
        });
      }
      let cloned: Cloned | undefined;
      if (Option.isSome(source)) {
        // Nothing checked out (the clone and git's own checkout both
        // failed, or the run was interrupted midway): the add goes again,
        // and the branch it made, as git undoes its own failed checkout. A
        // failed hook leaves the worktree, as git leaves it.
        const undo = git
          .run(project.path, ["worktree", "remove", "--force", place])
          .pipe(
            Effect.andThen(
              branch === ""
                ? Effect.void
                : git.run(project.path, ["branch", "-D", branch]),
            ),
            Effect.ignore,
          );
        const outcome = yield* cloneCheckout
          .finish({ source: source.value.path, worktree: place })
          .pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) &&
              (Cause.hasInterrupts(exit.cause) ||
                Cause.hasDies(exit.cause) ||
                Option.exists(
                  Cause.findErrorOption(exit.cause),
                  (error) => error instanceof CloneCheckout.CheckoutUnfinished,
                ))
                ? undo
                : Effect.void,
            ),
          );
        cloned = { from: source.value, outcome };
      }
      const found = yield* identities(project);
      const made = found.find((id) => id.path === place);
      if (!made) {
        return yield* new WorktreeRefused({
          reason: "vanished",
          subject: place,
        });
      }
      return { made, found, cloned };
    });

  const create = Effect.fn("Worktrees.create")(function* (
    project: RegisteredProject,
    input: {
      readonly name?: string | undefined;
      readonly branch?: string | undefined;
      readonly base?: string | undefined;
      readonly checkout?: boolean | undefined;
      readonly skipSetup?: boolean | undefined;
      readonly agentWorking?: boolean | undefined;
      readonly clone?: boolean | undefined;
    },
    reporter: Reporter,
  ) {
    const name = input.name ?? "";
    yield* checkName(name);
    const { made, found, cloned } = yield* addWorktree(project, {
      name,
      branch: input.branch ?? "",
      base: input.base ?? "",
      checkout: input.checkout ?? false,
      clone: input.clone ?? true,
    });
    // Only a worktree that is new takes the autoPullNew setting's mark.
    const [autoPullNew, primaryOnly] = yield* Effect.all([
      deviceFlag("autoPullNew"),
      deviceFlag("autoPullPrimaryOnly"),
    ]);
    if (autoPullNew && !primaryOnly) {
      yield* registry.setMark("autoPull", made.id, true);
    }
    if (input.agentWorking) {
      yield* registry.setMark("agentWorking", made.id, true);
    }
    const worktree = yield* row({ project, worktree: made });
    yield* reporter.report({ event: "created", worktree });
    const failures = yield* createLifecycle(
      project,
      made,
      found,
      input.base ?? "",
      input.skipSetup ?? false,
      reporter,
    );
    return { worktree, failures, cloned };
  });

  // Fails closed on a dirty or unreadable worktree, untracked files
  // counted whatever the user's setting, since the next step destroys
  // the folder.
  const requireClean = (
    worktree: WorktreeIdentity,
    force: boolean,
    verb: string,
    destroys: string,
  ) =>
    force
      ? Effect.void
      : git.changedCount(worktree.path).pipe(
          Effect.mapError(
            (cause) =>
              new DirtyWorktree({
                reason: "unreadable",
                count: 0,
                verb,
                destroys,
                cause:
                  cause instanceof Git.GitCommandError
                    ? new Error(Git.stderrOf(cause))
                    : cause,
              }),
          ),
          Effect.flatMap((count) =>
            count === 0
              ? Effect.void
              : Effect.fail(
                  new DirtyWorktree({
                    reason: "uncommitted",
                    count,
                    verb,
                    destroys,
                  }),
                ),
          ),
        );

  // An admin dir that is definitely gone: an unreadable one must not
  // pass for a finished sweep.
  const gone = (dir: string) =>
    fs.stat(dir).pipe(
      Effect.as(false),
      Effect.catchIf(isNotFound, () => Effect.succeed(true)),
      Effect.orElseSucceed(() => false),
    );

  // rm -rf, retried for a few seconds while a folder keeps refilling: the
  // writer that defeated git's sweep may still be landing files.
  const wipe = (dir: string) =>
    fs.remove(dir, { recursive: true, force: true }).pipe(
      Effect.retry({
        while: (error) =>
          Predicate.hasProperty(error.cause, "code") &&
          error.cause.code === "ENOTEMPTY",
        schedule: Schedule.spaced("250 millis").pipe(
          Schedule.upTo({ duration: "5 seconds" }),
        ),
      }),
    );

  // `git worktree remove`, finishing the sweep when git couldn't. Git
  // drops its admin entry whether or not the sweep finished, so a sweep
  // a watcher outran leaves a folder no later remove can reach. The wipe
  // takes only what git had agreed to delete: it runs when the admin
  // entry was there before and is gone after.
  const removeCheckout = (repo: string, worktreePath: string, force: boolean) =>
    Effect.gen(function* () {
      const admin = yield* git.adminDirOf(worktreePath);
      const removed = yield* git
        .removeWorktree({ repo, path: worktreePath, force })
        .pipe(Effect.result);
      if (Result.isSuccess(removed)) return;
      if (Option.isNone(admin) || !(yield* gone(admin.value))) {
        return yield* removed.failure;
      }
      yield* wipe(worktreePath).pipe(
        Effect.mapError(
          (error) =>
            new OrphanedWorktree({
              path: worktreePath,
              git:
                removed.failure instanceof Git.GitCommandError
                  ? Git.stderrOf(removed.failure)
                  : removed.failure.message,
              wipe: error.message,
            }),
        ),
      );
    });

  // Removes the folders a worktree leaves empty when they are ours: the
  // project's folder under the managed root, the in-project base, and the
  // managed root on the project's drive, whole once the last project
  // leaves it.
  const pruneEmptyParents = (worktreePath: string, projectPath: string) =>
    Effect.gen(function* () {
      const parent = path.dirname(worktreePath);
      const place = { dataDir: paths.dataDir, dataDirName: paths.dataDirName };
      const levels =
        parent ===
        path.join(paths.dataDir, "worktrees", path.basename(projectPath))
          ? 1
          : parent === path.join(projectPath, ".shigomori", "worktrees")
            ? 2
            : parent === driveBaseOf(projectPath, place)
              ? 3
              : 0;
      // rmdir, which takes only an empty folder: something written there
      // since keeps it.
      let dir = parent;
      for (let level = 0; level < levels; level++) {
        const code = yield* spawner.exitCode(ChildProcess.make("rmdir", [dir]));
        if (code !== 0) return;
        dir = path.dirname(dir);
      }
    }).pipe(Effect.ignore);

  // What is kept under an id that is going away: marks, the shelf, the
  // title, and a pending dirty capture.
  const forget = (project: RegisteredProject, worktreeId: string) =>
    Effect.all([
      registry.forgetWorktree(worktreeId),
      data.forget(project.id, worktreeId),
      git.deleteRef(project.path, dirtyRef(worktreeId)).pipe(Effect.ignore),
      // What clones proved about its files, as a source.
      cloneCheckout.forget(worktreeId),
    ]);

  // What is kept under one id, carried to another.
  const rekeyWorktree = (
    project: RegisteredProject,
    from: string,
    to: string,
  ) =>
    Effect.gen(function* () {
      yield* registry.moveWorktree(from, to);
      yield* data.move(project.id, from, to);
      // A pending capture belongs to the worktree, not its old path.
      const capture = yield* git.refTip(project.path, dirtyRef(from));
      if (Option.isSome(capture)) {
        yield* git
          .updateRef({
            repo: project.path,
            ref: dirtyRef(to),
            commit: capture.value,
          })
          .pipe(
            Effect.andThen(git.deleteRef(project.path, dirtyRef(from))),
            Effect.ignore,
          );
      }
    });

  const notPrimary = (worktree: WorktreeIdentity) =>
    worktree.isPrimary
      ? Effect.fail(
          new WorktreeRefused({
            reason: "remove-primary",
            subject: worktree.path,
          }),
        )
      : Effect.void;

  const removable = (worktree: WorktreeIdentity, force: boolean) =>
    notPrimary(worktree).pipe(
      Effect.andThen(requireClean(worktree, force, "remove", "")),
    );

  const remove = Effect.fn("Worktrees.remove")(function* (
    located: Located,
    options: {
      readonly force: boolean;
      readonly keepBranch: boolean;
      readonly skipCleanup: boolean;
      readonly preflighted?: boolean;
    },
    reporter: Reporter,
  ) {
    const { project, worktree } = located;
    yield* options.preflighted
      ? notPrimary(worktree)
      : removable(worktree, options.force);
    const deleteBranchOnRemove = (yield* config
      .get({ kind: "device" }, "deleteBranchOnRemove")
      .pipe(Effect.orDie)).value;
    // Never for an external worktree: no provision ever ran.
    let cleanupRan = false;
    if (!worktree.isExternal && !options.skipCleanup) {
      const { settings } = yield* projectSettings(project);
      const teardown = scriptOf(settings, "teardown");
      const pool = yield* portPoolActive(worktree);
      if (pool || teardown !== "") {
        const context = yield* scriptContext(project, worktree);
        const cleanup = (
          phase: CleanupFailed["phase"],
          command: string,
          slot: LifecycleSlot,
        ) =>
          runScript(context, reporter, command, slot).pipe(
            Effect.flatMap(({ code, runId }) =>
              code === 0
                ? Effect.void
                : Effect.fail(
                    new CleanupFailed({ phase, exitCode: code, runId }),
                  ),
            ),
          );
        cleanupRan = true;
        if (pool) {
          yield* cleanup(
            "portPoolRelease",
            `port-pool release ${shellQuote(worktree.path)}`,
            { kind: "portPool", phase: "release" },
          );
        }
        if (teardown !== "") {
          yield* cleanup("teardown", teardown, { kind: "teardown" });
        }
      }
    }
    // Unforced, git checks the tree again at the delete, which covers
    // what a cleanup script wrote since the check above.
    const removed = yield* removeCheckout(
      project.path,
      worktree.path,
      options.force,
    ).pipe(Effect.result);
    if (
      Result.isFailure(removed) &&
      !(removed.failure instanceof OrphanedWorktree)
    ) {
      const failure = removed.failure;
      if (
        !options.force &&
        failure instanceof Git.GitCommandError &&
        Git.stderrOf(failure).includes("contains modified or untracked files")
      ) {
        return yield* new WorktreeRefused({
          reason: cleanupRan
            ? "changed-during-cleanup"
            : "uncommitted-at-remove",
          subject: worktree.path,
        });
      }
      return yield* failure;
    }
    // An orphaned checkout is git's side done, so the bookkeeping still
    // follows it.
    if (!worktree.isExternal) {
      yield* pruneEmptyParents(worktree.path, project.path);
    }
    yield* forget(project, worktree.id);
    if (
      !options.keepBranch &&
      deleteBranchOnRemove !== false &&
      !worktree.isExternal &&
      worktree.branch !== UNKNOWN_BRANCH
    ) {
      // The branch may be shared, or the primary's: a failure is fine.
      yield* git
        .run(project.path, ["branch", "-D", "--", worktree.branch])
        .pipe(Effect.ignore);
    }
    if (Result.isFailure(removed)) return yield* removed.failure;
    return {
      id: worktree.id,
      name: worktree.name,
      branch: worktree.branch,
      path: worktree.path,
      projectName: project.name,
    };
  });

  // The move git can't make, across volumes: the checkout copied over,
  // git pointed at the copy, and the original gone only once git lists
  // the worktree at its new path. A failure before that leaves the
  // original as it was.
  const moveAcrossVolumes = (
    project: RegisteredProject,
    from: string,
    to: string,
  ) =>
    Effect.gen(function* () {
      const undo = wipe(to).pipe(
        Effect.andThen(
          git.run(project.path, ["worktree", "repair", "--", from]),
        ),
        Effect.ignore,
      );
      const cp = (flags: ReadonlyArray<string>) =>
        copyTree(spawner, from, to, flags);
      // -p keeps the times and modes. A volume that can't hold some of
      // them fails it, so the plain copy is the second try.
      const copied = yield* cp(["-p"]).pipe(
        Effect.catch(() => wipe(to).pipe(Effect.andThen(cp([])))),
        Effect.result,
      );
      if (Result.isFailure(copied)) {
        yield* undo;
        return yield* new WorktreeRefused({
          reason: "move-copy-failed",
          subject: to,
          cause: copied.failure.cause,
        });
      }
      const repaired = yield* git
        .run(project.path, ["worktree", "repair", "--", to])
        .pipe(Effect.andThen(findMoved(project, to)), Effect.result);
      if (Result.isFailure(repaired)) {
        yield* undo;
        return yield* repaired.failure;
      }
      // A leftover original is a stray folder, not a failed move.
      yield* wipe(from).pipe(Effect.ignore);
    });

  // The worktree git lists at `to`, in git's spelling (a symlinked
  // parent resolved), which the new id derives from.
  const findMoved = (project: RegisteredProject, to: string) =>
    Effect.gen(function* () {
      const resolved = yield* fs
        .realPath(to)
        .pipe(Effect.orElseSucceed(() => ""));
      const moved = (yield* identities(project)).find(
        (id) => id.path === to || (resolved !== "" && id.path === resolved),
      );
      if (!moved) {
        return yield* new WorktreeRefused({
          reason: "move-not-listed",
          subject: to,
        });
      }
      return moved;
    });

  const move = Effect.fn("Worktrees.move")(function* (
    located: Located,
    target: string,
  ) {
    const { project, worktree } = located;
    if (worktree.isPrimary) {
      return yield* new WorktreeRefused({
        reason: "move-primary",
        subject: "",
      });
    }
    const to = path.normalize(target);
    if (to !== worktree.path) {
      // git would move the checkout into an existing folder, at a path
      // (and an id) other than the one asked for.
      if (yield* occupied(to)) {
        return yield* new WorktreeRefused({
          reason: "move-destination-exists",
          subject: to,
        });
      }
      yield* fs
        .makeDirectory(path.dirname(to), { recursive: true })
        .pipe(Effect.orDie);
      const moved = yield* git
        .run(project.path, ["worktree", "move", "--", worktree.path, to])
        .pipe(
          Effect.catchTags({
            GitCommandError: (error) =>
              Git.stderrOf(error).toLowerCase().includes("cross-device link")
                ? moveAcrossVolumes(project, worktree.path, to)
                : Effect.fail(error),
          }),
          Effect.result,
        );
      if (Result.isFailure(moved)) {
        // The folders made for it go again when they are ours and empty.
        yield* pruneEmptyParents(to, project.path);
        return yield* moved.failure;
      }
      yield* pruneEmptyParents(worktree.path, project.path);
    }
    const moved = yield* findMoved(project, to);
    if (moved.id !== worktree.id) {
      yield* rekeyWorktree(project, worktree.id, moved.id);
    }
    return {
      worktree: yield* row({ project, worktree: moved }),
      previousId: worktree.id,
    };
  });

  const rekey = Effect.fn("Worktrees.rekey")(function* (
    project: RegisteredProject,
    from: string,
    toPath: string,
  ) {
    const to = worktreeIdFromPath(path.normalize(toPath));
    if (to !== from) yield* rekeyWorktree(project, from, to);
    return to;
  });

  const adopt = Effect.fn("Worktrees.adopt")(function* (
    located: Located,
    options: { readonly force: boolean },
    reporter: Reporter,
  ) {
    const { project, worktree } = located;
    if (worktree.isPrimary) {
      return yield* new WorktreeRefused({
        reason: "adopt-primary",
        subject: "",
      });
    }
    if (!worktree.isExternal) {
      return yield* new WorktreeRefused({
        reason: "adopt-managed",
        subject: "",
      });
    }
    // Adopting re-checks-out the branch tip, so what is uncommitted goes.
    yield* requireClean(worktree, options.force, "adopt", "adopting");
    const name = worktree.detached
      ? worktree.branch
      : sanitizeBranchForPath(worktree.branch);
    // Refused before the wipe below: the add's own check runs after the
    // old folder is gone.
    if (name !== "") {
      const clash = (yield* identities(project)).some(
        (other) =>
          other.id !== worktree.id &&
          other.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash) {
        return yield* new WorktreeRefused({
          reason: "name-taken",
          subject: name,
        });
      }
    }
    yield* removeCheckout(project.path, worktree.path, true);
    yield* registry.setMark("shelved", worktree.id, false);
    yield* registry.setMark("agentWorking", worktree.id, false);
    const { made, found, cloned } = yield* addWorktree(project, {
      name,
      branch: "",
      base: worktree.branch,
      checkout: true,
      clone: true,
    });
    // The checkout moved, so its id did too, like after a move.
    if (made.id !== worktree.id) {
      yield* rekeyWorktree(project, worktree.id, made.id);
    }
    const adopted = yield* row({ project, worktree: made });
    yield* reporter.report({ event: "created", worktree: adopted });
    const failures = yield* createLifecycle(
      project,
      made,
      found,
      "",
      false,
      reporter,
    );
    return { worktree: adopted, failures, cloned };
  });

  const setup = Effect.fn("Worktrees.setup")(function* (
    located: Located,
    reporter: Reporter,
  ) {
    const { settings } = yield* projectSettings(located.project);
    const outcome = yield* provision(
      located.project,
      located.worktree,
      settings,
      false,
      reporter,
    );
    if (outcome.ran.length > 0) {
      yield* reporter.report({ event: "phase", phase: "idle" });
    }
    return outcome;
  });

  // The linked worktrees that moved along with the repo: git lists them
  // at a path that is gone, and they sit at the same place relative to
  // the repo's new path. Inside the repo, or beside it when a parent
  // folder moved whole, each ancestor pair that still shares a name
  // tried, nearest first. Old path to new.
  const movedAlong = (repo: string, oldPath: string) =>
    Effect.gen(function* () {
      const moved = new Map<string, string>();
      const entries = yield* git
        .listWorktrees(repo)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<WorktreeEntry> => []));
      const pairs: Array<readonly [string, string]> = [[oldPath, repo]];
      for (
        let from = oldPath, to = repo;
        path.basename(from) === path.basename(to);
      ) {
        from = path.dirname(from);
        to = path.dirname(to);
        if (from === to || from === path.dirname(from)) break;
        pairs.push([from, to]);
      }
      for (const entry of entries) {
        if (
          yield* fs.exists(entry.path).pipe(Effect.orElseSucceed(() => true))
        ) {
          continue;
        }
        for (const [from, to] of pairs) {
          if (!entry.path.startsWith(`${from}/`)) continue;
          const candidate = path.join(to, entry.path.slice(from.length + 1));
          const isDirectory = yield* fs.stat(candidate).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          );
          if (isDirectory) {
            moved.set(entry.path, candidate);
            break;
          }
        }
      }
      return moved;
    });

  // `git worktree repair` for the moved ones, and what each kept under
  // its old id re-keyed. git repairs each path on its own, so the ones it
  // did re-link are re-keyed whatever it answers.
  const relinkMoved = (
    project: RegisteredProject,
    moved: ReadonlyMap<string, string>,
  ) =>
    Effect.gen(function* () {
      yield* git
        .run(project.path, ["worktree", "repair", "--", ...moved.values()])
        .pipe(Effect.ignore);
      const found = yield* identities(project).pipe(
        Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []),
      );
      for (const [oldPath, newPath] of moved) {
        const resolved = yield* fs
          .realPath(newPath)
          .pipe(Effect.orElseSucceed(() => ""));
        const now = found.find(
          (id) =>
            id.path === newPath || (resolved !== "" && id.path === resolved),
        );
        if (now === undefined) continue;
        const from = worktreeIdFromPath(oldPath);
        if (from !== now.id) yield* rekeyWorktree(project, from, now.id);
      }
    });

  // The managed bases are named after the repo's folder, so a rename
  // would leave the managed worktrees reading as external. Each moves to
  // where new worktrees go.
  const rehomeManaged = (project: RegisteredProject, oldPath: string) =>
    Effect.gen(function* () {
      const oldBases = yield* layout.managedBases({
        ...project,
        path: oldPath,
      });
      const newBases = yield* layout.managedBases(project);
      const base = yield* layout.worktreeBase(project);
      const found = yield* identities(project).pipe(
        Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []),
      );
      for (const worktree of found) {
        if (
          worktree.isPrimary ||
          !isManagedPath(worktree.path, oldBases) ||
          isManagedPath(worktree.path, newBases) ||
          !(yield* fs
            .exists(worktree.path)
            .pipe(Effect.orElseSucceed(() => false)))
        ) {
          continue;
        }
        yield* move(
          { project, worktree },
          path.join(base, path.basename(worktree.path)),
        ).pipe(Effect.ignore);
      }
    });

  const relocateProject = Effect.fn("Worktrees.relocateProject")(function* (
    project: Registry.ListedProject,
    target: string,
  ) {
    const refuse = (reason: RelocateRefused["reason"], at: string) =>
      new RelocateRefused({ reason, path: at, name: project.name, binary });
    if (project.source === "terrier") {
      return yield* refuse("via-terrier", project.path);
    }
    // Folded to the primary checkout, so a folder inside the repo or one
    // of its worktrees still lands on the repo.
    const repo = yield* git.locate(target);
    if (Option.isNone(repo)) return yield* refuse("not-a-repo", target);
    const to = repo.value.primaryPath;
    if (to !== project.path) {
      // Only for a repo that went: pointing a project that is still there
      // at another repo would hand that repo its settings and marks.
      const stillThere = yield* fs.stat(project.path).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (stillThere) return yield* refuse("still-there", project.path);
      // terrier's rows merge in by path, so either side being one would
      // list one repo twice.
      const { paths: listed } = yield* terrier.listing;
      if (listed.includes(project.path)) {
        return yield* refuse("terrier-lists-old", project.path);
      }
      if (listed.includes(to)) return yield* refuse("terrier-lists-new", to);
      const relocated = yield* registry.relocate(
        project.id,
        to,
        path.basename(to),
      );
      // Best effort from here: the entry already points at the new path.
      const moved = yield* movedAlong(to, project.path);
      moved.set(project.path, to);
      yield* relinkMoved(relocated, moved);
      yield* rehomeManaged(relocated, project.path);
    }
    const rows = yield* registry.rows();
    const found = rows.find((listed) => listed.id === project.id);
    if (!found)
      return yield* new Registry.UnknownProject({ projectId: project.id });
    return found;
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
    setAgentWorking,
    description,
    describe,
    destination,
    create,
    adopt,
    setup,
    remove,
    move,
    rekey,
    relocateProject,
    snapshotted: sql<{ worktree_id: string }>`
      SELECT worktree_id FROM shelf_snapshots`.pipe(
      Effect.map((rows) => new Set(rows.map(({ worktree_id }) => worktree_id))),
      Effect.orDie,
      Effect.withSpan("Worktrees.snapshotted"),
    ),
    checkRemovable: (located, force) => removable(located.worktree, force),
    primaryTarget: (project) =>
      primaryRefOf(project).pipe(
        Effect.map(({ remotes, primaryRef, primaryBranch }) => ({
          remotes,
          primaryRef,
          remote: splitRemoteRef(primaryRef, remotes)?.remote ?? "",
          primaryBranch,
        })),
      ),
  });
});

export const layer = Layer.effect(Worktrees, make);
