// Every git the engine runs, and what it reads out of it: the probes a
// worktree row is built from, refs and branches, the remote sync, the
// changes page's index work, and the diffs. One runner under all of
// it, so the spawn cap, the locale and the errors are the same for
// every caller.
import type {
  BranchList,
  ChangeCounts,
  ChangedFile,
  CommitMessage,
  CommitSummary,
} from "@shigomori/contracts/schemas";
import { MIRROR_IGNORES_LIMIT } from "@shigomori/contracts/mirrorIgnores";
import { isUntracked } from "@shigomori/contracts/schemas";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  anchorRule,
  branchListOf,
  type BranchRefs,
  ignoreRulesOf,
  LOG_FORMAT,
  parseBranchRefs,
  parseLeftRight,
  parseLog,
  parseNumstat,
  parseRemoteEntries,
  parseStatus,
  parseWorktreeList,
  pickDefaultRef,
  shortRefName,
  splitLines,
  splitRemoteRef,
  splitZ,
  subcommandOf,
  type WorktreeEntry,
} from "./gitParse.ts";

// --- errors -----------------------------------------------------------

// A git that failed. `cause` holds git's own words (its stderr), which
// is what a person can act on. `exitCode` is null when git never got
// to exit: it could not be spawned, or a signal ended it.
export class GitCommandError extends Schema.TaggedError<GitCommandError>()(
  "GitCommandError",
  {
    subcommand: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.exitCode === null
      ? `git ${this.subcommand} did not finish.`
      : `git ${this.subcommand} exited with ${this.exitCode}.`;
  }
}

// Output past the run's cap. Not a git failure: what was read is a
// prefix of the real thing, which for a patch means whole files
// silently missing from its end.
export class GitOutputTooLargeError extends Schema.TaggedError<GitOutputTooLargeError>()(
  "GitOutputTooLargeError",
  { subcommand: Schema.String, limitBytes: Schema.Int },
) {
  override get message(): string {
    return "git produced more output than the app can hold.";
  }
}

export type GitError = GitCommandError | GitOutputTooLargeError;

// git's safe delete refused: the branch has commits no other branch
// has. The caller can offer the forced delete.
export class BranchNotMergedError extends Schema.TaggedError<BranchNotMergedError>()(
  "BranchNotMergedError",
  { branch: Schema.String },
) {
  override get message(): string {
    return `Branch '${this.branch}' has unmerged commits.`;
  }
}

// What an overwrite from the upstream would destroy: uncommitted work,
// or ignored files the upstream tracks at the same paths. `paths` names
// the first few, `count` all of them.
export class OverwriteRefusedError extends Schema.TaggedError<OverwriteRefusedError>()(
  "OverwriteRefusedError",
  {
    reason: Schema.Literals(["uncommitted", "ignored-files"]),
    paths: Schema.Array(Schema.String),
    count: Schema.Int,
  },
) {
  override get message(): string {
    return this.reason === "uncommitted"
      ? "This worktree has uncommitted or untracked changes. Commit, stash, or discard them before overwriting from upstream."
      : `Overwriting would replace ignored local file(s) the upstream branch tracks: ${listed(this.paths, this.count)}. Move them aside first.`;
  }
}

export class NoRemoteError extends Schema.TaggedError<NoRemoteError>()(
  "NoRemoteError",
  {},
) {
  override get message(): string {
    return "No git remote configured";
  }
}

// Why an undo (or its redo) would not move HEAD: it moved since the
// page loaded, the target is off HEAD's line, or a merge is between.
export class UndoRefusedError extends Schema.TaggedError<UndoRefusedError>()(
  "UndoRefusedError",
  { reason: Schema.Literals(["moved", "off-history", "across-merge"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "moved":
        return "The branch has moved on since this was loaded. Reload and try again.";
      case "off-history":
        return "That commit isn't on this branch's history.";
      case "across-merge":
        return "Can't undo across a merge commit.";
    }
  }
}

// A discard that left untracked paths behind: `clean` walks past a
// nested repository, and the snapshot holds only its gitlink.
export class NestedRepositoryError extends Schema.TaggedError<NestedRepositoryError>()(
  "NestedRepositoryError",
  { paths: Schema.Array(Schema.String), count: Schema.Int },
) {
  override get message(): string {
    return `Couldn't remove ${listed(this.paths, this.count)}. A nested git repository has to be removed by hand.`;
  }
}

export class CloneDestinationError extends Schema.TaggedError<CloneDestinationError>()(
  "CloneDestinationError",
  {
    path: Schema.String,
    reason: Schema.Literals(["not-a-folder", "exists"]),
  },
) {
  override get message(): string {
    return this.reason === "exists"
      ? `${this.path} already exists`
      : `${this.path} is not a folder`;
  }
}

// git's own words for a failure, which the error keeps as its cause.
export const stderrOf = (error: GitCommandError): string =>
  error.cause instanceof Error ? error.cause.message : String(error.cause);

const SHOWN = 3;
const listed = (paths: readonly string[], count: number): string =>
  `${paths.join(", ")}${count > paths.length ? ` (+${count - paths.length} more)` : ""}`;

// --- the service --------------------------------------------------------

export type RunOptions = {
  // Layered over the inherited environment for this one spawn (a
  // scratch GIT_INDEX_FILE, say).
  readonly env?: Readonly<Record<string, string>> | undefined;
  // Fed to the child, for the batch modes that answer many questions
  // in one spawn.
  readonly stdin?: string | undefined;
  // Exit codes that still mean an answer: `diff --no-index` exits 1
  // whenever it has a diff to print.
  readonly okExitCodes?: readonly number[] | undefined;
  // The output cap, over DEFAULT_MAX_OUTPUT. Only the patch reads
  // raise it.
  readonly maxOutputBytes?: number | undefined;
};

export type UpstreamSync = {
  readonly ahead: number;
  readonly behind: number;
  readonly hasUpstream: boolean;
  // Diverged both ways, and a merge of the two would be clean.
  readonly divergedClean: boolean;
};

export type PrimaryRelation = {
  readonly behindPrimary: number;
  readonly mergedIntoPrimary: boolean;
};

export class Git extends Context.Service<
  Git,
  {
    // The one way to run git. Everything below goes through it.
    readonly run: (
      cwd: string,
      args: readonly string[],
      options?: RunOptions,
    ) => Effect.Effect<string, GitError>;
    readonly isRepo: (path: string) => Effect.Effect<boolean>;

    // --- worktrees ---
    readonly listWorktrees: (
      repo: string,
    ) => Effect.Effect<WorktreeEntry[], GitError>;
    // A worktree on a new branch from `base` (HEAD without one).
    // `noCheckout` leaves the files and the index to the caller (a
    // clone checkout).
    readonly addWorktree: (input: {
      readonly repo: string;
      readonly path: string;
      readonly branch: string;
      readonly base?: string | undefined;
      readonly noCheckout?: boolean | undefined;
    }) => Effect.Effect<void, GitError>;
    // A worktree on an existing ref, landing on a branch rather than a
    // detached HEAD (resolveCheckoutRef).
    readonly checkoutWorktree: (input: {
      readonly repo: string;
      readonly path: string;
      readonly ref: string;
      readonly remotes?: readonly string[] | undefined;
      readonly noCheckout?: boolean | undefined;
    }) => Effect.Effect<void, GitError>;
    // Unforced, git refuses a dirty tree, untracked files included
    // whatever the user's status setting says.
    readonly removeWorktree: (input: {
      readonly repo: string;
      readonly path: string;
      readonly force: boolean;
    }) => Effect.Effect<void, GitError>;
    // Drops admin entries whose checkout directory is gone.
    readonly pruneWorktrees: (repo: string) => Effect.Effect<void, GitError>;

    // --- the working tree ---
    // Every changed file. `untracked: "normal"` sees untracked files
    // even where the user turned them off (`status.showUntrackedFiles
    // no`), for the guards ahead of an overwrite or a removal; "all"
    // lists each file of an untracked directory. Without it the user's
    // setting holds, which keeps the display probes cheap.
    readonly status: (
      worktree: string,
      untracked?: "normal" | "all",
    ) => Effect.Effect<ChangedFile[], GitError>;
    // What the changes page lists: every file as its own row, with its
    // line counts.
    readonly changes: (
      worktree: string,
    ) => Effect.Effect<ChangedFile[], GitError>;
    // A row's change count and the newest mtime among the changes
    // (epoch ms, 0 for none).
    readonly workingTreeChanges: (
      worktree: string,
    ) => Effect.Effect<{ count: number; lastChangeAt: number }, GitError>;
    // Changed files, untracked ones always counted: the guard ahead of
    // anything that deletes the folder.
    readonly changedCount: (
      worktree: string,
    ) => Effect.Effect<number, GitError>;

    // --- history ---
    // Commits only on HEAD and only on `ref`, or none when the ref does
    // not resolve here or HEAD is unborn.
    readonly aheadBehind: (
      worktree: string,
      ref: string,
    ) => Effect.Effect<Option.Option<{ ahead: number; behind: number }>>;
    readonly upstreamSync: (worktree: string) => Effect.Effect<UpstreamSync>;
    // HEAD's newest commits no remote has, capped at UNPUSHED_LIMIT:
    // what amend and undo may touch.
    readonly unpushedCount: (worktree: string) => Effect.Effect<number>;
    // A page of `git log HEAD`, newest first. Empty on any failure (an
    // unborn branch, a rebase in progress).
    readonly listCommits: (
      worktree: string,
      page: { readonly skip: number; readonly count: number },
    ) => Effect.Effect<CommitSummary[]>;
    // The first-parent chain of `ref`, as far back as
    // primaryRelation can ask about. None when it can't be read.
    readonly firstParentChain: (
      repo: string,
      ref: string,
    ) => Effect.Effect<Option.Option<ReadonlySet<string>>>;
    // How a branch sits against the project's primary ref. `chain` is
    // the primary's firstParentChain, read once per project by the
    // caller and asked only when needed.
    readonly primaryRelation: (input: {
      readonly worktree: string;
      readonly primaryRef: string;
      readonly chain: Effect.Effect<Option.Option<ReadonlySet<string>>>;
    }) => Effect.Effect<PrimaryRelation>;
    readonly readCommitMessage: (
      worktree: string,
      hash: string,
    ) => Effect.Effect<CommitMessage, GitError>;

    // --- refs and objects ---
    // The commit a ref resolves to, none when it does not exist.
    readonly refTip: (
      cwd: string,
      ref: string,
    ) => Effect.Effect<Option.Option<string>>;
    readonly verifyRev: (
      cwd: string,
      rev: string,
    ) => Effect.Effect<string, GitError>;
    readonly treeOf: (
      cwd: string,
      commit: string,
    ) => Effect.Effect<string, GitError>;
    readonly hasObject: (cwd: string, object: string) => Effect.Effect<boolean>;
    readonly hasCommit: (cwd: string, commit: string) => Effect.Effect<boolean>;
    readonly isAncestor: (
      cwd: string,
      ancestor: string,
      descendant: string,
    ) => Effect.Effect<boolean, GitError>;
    // With `expected`, a compare-and-set: the ref moves only while it
    // still points there (forty zeros: only while it does not exist).
    readonly updateRef: (input: {
      readonly repo: string;
      readonly ref: string;
      readonly commit: string;
      readonly expected?: string | undefined;
    }) => Effect.Effect<void, GitError>;
    // A missing ref is fine.
    readonly deleteRef: (
      repo: string,
      ref: string,
    ) => Effect.Effect<void, GitError>;
    // Tips of every local branch, deduped, at most 256 (a thin
    // bundle's haves).
    readonly localBranchTips: (
      repo: string,
    ) => Effect.Effect<string[], GitError>;
    // Every remote-tracking ref and its commit as one string, compared
    // before and after a fetch.
    readonly snapshotRemoteRefs: (
      repo: string,
    ) => Effect.Effect<string, GitError>;

    // --- branches and remotes ---
    readonly listRemotes: (repo: string) => Effect.Effect<string[]>;
    readonly listRemoteEntries: (
      repo: string,
    ) => Effect.Effect<{ name: string; url: string }[]>;
    readonly branchRefs: (repo: string) => Effect.Effect<BranchRefs, GitError>;
    // Local heads and remote-tracking refs, for a base-ref picker.
    readonly listBranches: (
      repo: string,
    ) => Effect.Effect<BranchList, GitError>;
    readonly localBranchExists: (
      repo: string,
      branch: string,
    ) => Effect.Effect<boolean>;
    readonly remoteRefExists: (
      repo: string,
      ref: string,
    ) => Effect.Effect<boolean>;
    // The fully qualified default ref repo identity keys off (see
    // pickDefaultRef), none when there is none.
    readonly resolveDefaultRef: (
      repo: string,
      override?: string,
    ) => Effect.Effect<Option.Option<string>>;
    // The short-named primary ref a row is measured against, which may
    // also fall back to the first local branch: a merge target only
    // has to exist. `remotes` saves a `git remote` for a caller that
    // has them.
    readonly resolveDefaultBranch: (
      repo: string,
      override?: string,
      remotes?: readonly string[],
    ) => Effect.Effect<Option.Option<string>>;
    // What to hand git so a checkout of `ref` lands on a branch: an
    // exact local branch wins; a qualified remote ref resolves to its
    // local branch where that exists, and otherwise stays the ref with
    // `track` naming the tracking branch to create from it; anything
    // else goes to git as it is.
    readonly resolveCheckoutRef: (
      repo: string,
      ref: string,
      remotes?: readonly string[],
    ) => Effect.Effect<{ target: string; track: Option.Option<string> }>;
    // Switches a worktree to `branch`, the same way.
    readonly checkoutBranch: (
      worktree: string,
      branch: string,
      remotes?: readonly string[],
    ) => Effect.Effect<void, GitError>;
    // A branch at `base` (HEAD without one), tracking it when it is a
    // remote-tracking ref and not a local branch.
    readonly createBranch: (input: {
      readonly repo: string;
      readonly name: string;
      readonly base?: string | undefined;
    }) => Effect.Effect<void, GitError>;
    // Renames the branch checked out in `worktree`.
    readonly renameCurrentBranch: (
      worktree: string,
      name: string,
    ) => Effect.Effect<void, GitError>;
    // Renames any local branch. Git moves a worktree that has it out.
    readonly renameBranch: (input: {
      readonly repo: string;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<void, GitError>;
    // Without `force`, git's safe delete. Forced, git still refuses a
    // branch some worktree has out.
    readonly deleteBranch: (input: {
      readonly repo: string;
      readonly name: string;
      readonly force: boolean;
    }) => Effect.Effect<void, GitError | BranchNotMergedError>;
    // Untracked paths the standard excludes ignore, a fully ignored
    // directory collapsed to one "dir/" entry.
    readonly listIgnoredPaths: (
      repo: string,
    ) => Effect.Effect<string[], GitError>;
    // Untracked paths matched by the gitignore-syntax patterns in
    // `excludeFile` alone, the standard excludes left out.
    readonly listUntrackedMatching: (
      repo: string,
      excludeFile: string,
    ) => Effect.Effect<string[], GitError>;
    // The gitignore rules a worktree is under, root-relative: every
    // .gitignore git can see and the repository's info/exclude, at
    // most MIRROR_IGNORES_LIMIT.
    readonly listIgnoreRules: (worktree: string) => Effect.Effect<string[]>;

    // --- the remote ---
    // Fetches every remote of a repository. Overlapping callers share
    // one fetch, and it stops when the last of them is interrupted.
    readonly fetchAll: (repo: string) => Effect.Effect<void, GitError>;
    readonly push: (worktree: string) => Effect.Effect<void, GitError>;
    readonly pushForceWithLease: (
      worktree: string,
    ) => Effect.Effect<void, GitError>;
    readonly pullFastForward: (
      worktree: string,
    ) => Effect.Effect<void, GitError>;
    // Fast-forward onto the already-fetched upstream, no network. A
    // commit that raced the caller's checks fails it rather than
    // making a merge.
    readonly fastForwardToUpstream: (
      worktree: string,
    ) => Effect.Effect<void, GitError>;
    // Throws away the local divergence and snaps to the upstream, after
    // a fetch and a fresh look at what that would destroy.
    readonly overwriteFromUpstream: (
      worktree: string,
    ) => Effect.Effect<void, GitError | OverwriteRefusedError>;
    // Pushes the current branch to the repository's first remote and
    // tracks it there.
    readonly publish: (input: {
      readonly worktree: string;
      readonly repo: string;
    }) => Effect.Effect<void, GitError | NoRemoteError>;
    // The diverged-but-mergeable resolution: fetch, rebase onto the
    // upstream (a whole-tree merge when a commit conflicts), push.
    readonly pullRebaseOrMergeAndPush: (
      worktree: string,
    ) => Effect.Effect<void, GitError>;
    // Brings the primary ref's commits in the same way, after fetching
    // every remote (the primary can live on another remote than the
    // branch tracks).
    readonly syncWithPrimary: (input: {
      readonly worktree: string;
      readonly repo: string;
      readonly primaryRef: string;
    }) => Effect.Effect<void, GitError>;
    // Clones `url` into `parentDir/name` and returns the checkout. Git
    // never prompts for credentials here, and a URL's userinfo stays
    // out of the error.
    readonly clone: (input: {
      readonly url: string;
      readonly parentDir: string;
      readonly name: string;
    }) => Effect.Effect<string, GitError | CloneDestinationError>;

    // --- the index ---
    // Ticks or unticks whole files, then answers with a fresh listing.
    // Writes to one worktree's index run one after another.
    readonly setStaged: (input: {
      readonly worktree: string;
      readonly paths: readonly string[];
      readonly staged: boolean;
    }) => Effect.Effect<ChangedFile[], GitError>;
    // Commits the index, `stagePaths` added first, and answers with
    // the new HEAD's short hash. Hooks run as in a terminal.
    readonly commit: (input: {
      readonly worktree: string;
      readonly summary: string;
      readonly description?: string | undefined;
      readonly amend?: boolean | undefined;
      readonly stagePaths?: readonly string[] | undefined;
    }) => Effect.Effect<string, GitError>;
    // `reset --soft` along HEAD's own line: back to an ancestor (an
    // undo), or forward to a descendant when `expectHead` pins where
    // HEAD must still be (its redo). Answers with where HEAD was.
    readonly resetSoft: (input: {
      readonly worktree: string;
      readonly target: string;
      readonly expectHead?: string | undefined;
    }) => Effect.Effect<string, GitError | UndoRefusedError>;
    // Throws away the changes to `paths` after keeping them in a
    // snapshot commit under DISCARD_REF_PREFIX, and answers with it.
    readonly discard: (input: {
      readonly worktree: string;
      readonly paths: readonly string[];
    }) => Effect.Effect<string, GitError | NestedRepositoryError>;
    // Puts a discard back, in the working tree only.
    readonly restoreDiscard: (input: {
      readonly worktree: string;
      readonly snapshot: string;
    }) => Effect.Effect<void, GitError>;

    // --- diffs ---
    // One file's diff: against HEAD for a tracked file (`paths` leads
    // with its old name for a rename), against nothing for an untracked
    // one, which must be an untracked change git lists.
    readonly fileDiff: (input: {
      readonly worktree: string;
      readonly paths: readonly string[];
      readonly untracked: boolean;
    }) => Effect.Effect<string, GitError>;
    // A commit's patch without its header.
    readonly commitDiff: (
      worktree: string,
      hash: string,
    ) => Effect.Effect<string, GitError>;
    // `head` against its merge base with `base`, as a pull request
    // shows it.
    readonly mergeBaseDiff: (input: {
      readonly repo: string;
      readonly base: string;
      readonly head: string;
    }) => Effect.Effect<string, GitError>;
  }
>()("sm/engine/Git") {}

export const DISCARD_REF_PREFIX = "refs/shigomori/discards/";

// --- limits -------------------------------------------------------------

// The worktree list fans out over every project, worktree and probe.
// Unbounded, that is hundreds of processes and the time goes into
// fork and exec.
const SPAWN_SLOTS = Math.max(4, globalThis.navigator?.hardwareConcurrency ?? 4);

// Covers any status, log or ref output by a wide margin.
const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;

// A patch is the one output whose size the user decides: one
// regenerated lockfile runs to tens of megabytes on its own.
const PATCH_MAX_OUTPUT = 64 * 1024 * 1024;

// Pathspecs travel as argv, and a big refactor can carry enough paths
// to brush the OS's limit, so they go one chunk per git.
const PATHSPEC_CHUNK = 500;

// Past this many changed paths the newest change is almost certainly
// seen, and a huge dirty tree shouldn't cost a stat per file.
const CHANGE_MTIME_STATS = 64;

const UNPUSHED_LIMIT = 1000;

// How far behind the primary a branch can be and still be asked
// whether it landed. Past it the answer stopped mattering, and "not
// landed" leaves the row where it was.
const FIRST_PARENT_LIMIT = 2000;

const LOCAL_TIPS_LIMIT = 256;

const DISCARD_SNAPSHOTS_KEPT = 40;

// Untracked files are counted from disk with git's own limits: a NUL in
// the first 8k means binary, and past a few MB a count is not worth
// reading the file for.
const BINARY_SNIFF_BYTES = 8000;
const UNTRACKED_COUNT_LIMIT = 4 * 1024 * 1024;

// --- make ---------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const chunksOf = <T>(items: readonly T[]): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += PATHSPEC_CHUNK) {
    chunks.push(items.slice(i, i + PATHSPEC_CHUNK));
  }
  return chunks;
};

// Reads a pipe to its end, failing once it passes `limit` bytes.
const readAll = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  limit: number,
  tooLarge: () => GitOutputTooLargeError,
) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], size: 0 }),
      (acc, chunk: Uint8Array) => {
        acc.size += chunk.length;
        if (acc.size > limit) return Effect.fail(tooLarge());
        acc.chunks.push(chunk);
        return Effect.succeed(acc);
      },
    ),
    Effect.map(({ chunks, size }) => {
      const all = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      return decoder.decode(all);
    }),
  );

// git names the URL it wanted a password for, userinfo and all, and a
// pasted token sits there.
const redactUserinfo = (text: string): string =>
  text.replace(/(https?:\/\/)[^/\s'"]*@/gi, "$1");

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const slots = yield* Semaphore.make(SPAWN_SLOTS);

  const run = Effect.fn("Git.run")(function* (
    cwd: string,
    args: readonly string[],
    options: RunOptions = {},
  ) {
    const subcommand = subcommandOf(args);
    yield* Effect.annotateCurrentSpan({ subcommand, cwd });
    const failed = (exitCode: number | null) => (cause: unknown) =>
      new GitCommandError({ subcommand, exitCode, cause });
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const tooLarge = () =>
      new GitOutputTooLargeError({ subcommand, limitBytes: limit });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("git", [...args], {
              cwd,
              // LC_ALL=C pins git's messages to English, so what the
              // engine matches on and relays reads the same everywhere.
              env: { ...options.env, LC_ALL: "C" },
              extendEnv: true,
              // In a process group of its own (the spawner's default), so
              // closing the scope ends git with its hooks and its ssh.
              // That also leaves it no terminal to prompt on: a
              // credential or host-key question fails instead of waiting.
              stdin:
                options.stdin === undefined
                  ? "ignore"
                  : Stream.make(encoder.encode(options.stdin)),
            }),
          )
          .pipe(Effect.mapError(failed(null)));
        const [stdout, stderr] = yield* Effect.all(
          [
            readAll(
              handle.stdout.pipe(Stream.mapError(failed(null))),
              limit,
              tooLarge,
            ),
            readAll(
              handle.stderr.pipe(Stream.mapError(failed(null))),
              DEFAULT_MAX_OUTPUT,
              tooLarge,
            ),
          ],
          { concurrency: 2 },
        );
        const code = yield* handle.exitCode.pipe(Effect.mapError(failed(null)));
        if (code !== 0 && !(options.okExitCodes ?? []).includes(code)) {
          return yield* failed(code)(
            new Error(stderr.trim() || `git ${subcommand} exited with ${code}`),
          );
        }
        return stdout;
      }),
    ).pipe(slots.withPermit);
  });

  // Exit 0 or not, for the checks git answers with its exit code.
  const succeeds = (cwd: string, args: readonly string[]) =>
    run(cwd, args).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // One git per chunk of paths, in order, since index writes take
  // index.lock. Every path came out of git and is a filename, never a
  // pattern: without --literal-pathspecs `a[1].txt` is a glob.
  const runChunked = (
    worktree: string,
    args: readonly string[],
    paths: readonly string[],
    options?: RunOptions,
  ) =>
    Effect.forEach(chunksOf(paths), (chunk) =>
      run(worktree, ["--literal-pathspecs", ...args, "--", ...chunk], options),
    );

  // Writes to one worktree's index run one after another: git takes
  // index.lock for each, so two quick ticks, or a tick racing a commit,
  // would otherwise fail on the lock instead of waiting.
  const indexLocks = new Map<string, Semaphore.Semaphore>();
  const onIndex = <A, E>(worktree: string, task: Effect.Effect<A, E>) => {
    let lock = indexLocks.get(worktree);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      indexLocks.set(worktree, lock);
    }
    return lock.withPermit(task);
  };

  // --- worktrees ---

  const listWorktrees = Effect.fn("Git.listWorktrees")(function* (
    repo: string,
  ) {
    return parseWorktreeList(
      yield* run(repo, ["worktree", "list", "--porcelain"]),
    );
  });

  const addWorktree = Effect.fn("Git.addWorktree")(function* (input: {
    readonly repo: string;
    readonly path: string;
    readonly branch: string;
    readonly base?: string | undefined;
    readonly noCheckout?: boolean | undefined;
  }) {
    yield* run(input.repo, [
      "worktree",
      "add",
      "-b",
      input.branch,
      ...(input.noCheckout ? ["--no-checkout"] : []),
      "--",
      input.path,
      ...(input.base ? [input.base] : []),
    ]);
  });

  const listRemotes = Effect.fn("Git.listRemotes")(function* (repo: string) {
    return yield* run(repo, ["remote"]).pipe(
      Effect.map(splitLines),
      Effect.orElseSucceed(() => []),
    );
  });

  const localBranchExists = (repo: string, branch: string) =>
    succeeds(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);

  const remoteRefExists = (repo: string, ref: string) =>
    succeeds(repo, ["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`]);

  const resolveCheckoutRef = Effect.fn("Git.resolveCheckoutRef")(function* (
    repo: string,
    ref: string,
    remotes?: readonly string[],
  ) {
    if (yield* localBranchExists(repo, ref)) {
      return { target: ref, track: Option.none<string>() };
    }
    const split = splitRemoteRef(ref, remotes ?? (yield* listRemotes(repo)));
    if (!split) return { target: ref, track: Option.none<string>() };
    if (yield* localBranchExists(repo, split.branch)) {
      return { target: split.branch, track: Option.none<string>() };
    }
    return { target: ref, track: Option.some(split.branch) };
  });

  const checkoutWorktree = Effect.fn("Git.checkoutWorktree")(function* (input: {
    readonly repo: string;
    readonly path: string;
    readonly ref: string;
    readonly remotes?: readonly string[] | undefined;
    readonly noCheckout?: boolean | undefined;
  }) {
    const { target, track } = yield* resolveCheckoutRef(
      input.repo,
      input.ref,
      input.remotes,
    );
    yield* run(input.repo, [
      "worktree",
      "add",
      ...(input.noCheckout ? ["--no-checkout"] : []),
      ...Option.match(track, {
        onNone: () => [],
        onSome: (name) => ["--track", "-b", name],
      }),
      "--",
      input.path,
      target,
    ]);
  });

  const removeWorktree = Effect.fn("Git.removeWorktree")(function* (input: {
    readonly repo: string;
    readonly path: string;
    readonly force: boolean;
  }) {
    yield* run(input.repo, [
      "-c",
      "status.showUntrackedFiles=normal",
      "worktree",
      "remove",
      input.path,
      ...(input.force ? ["--force"] : []),
    ]);
  });

  const pruneWorktrees = Effect.fn("Git.pruneWorktrees")(function* (
    repo: string,
  ) {
    yield* run(repo, ["worktree", "prune"]);
  });

  // --- the working tree ---

  const status = Effect.fn("Git.status")(function* (
    worktree: string,
    untracked?: "normal" | "all",
  ) {
    return parseStatus(
      yield* run(worktree, [
        "status",
        "--porcelain=v2",
        "-z",
        ...(untracked ? [`--untracked-files=${untracked}`] : []),
      ]),
    );
  });

  // A new file's lines, all additions. Not a symlink's target, which
  // git sees as a one-line blob, and nothing too big or binary.
  const countUntracked = (worktree: string, file: string) => {
    const full = path.join(worktree, file);
    return Effect.gen(function* () {
      const isLink = yield* fs.readLink(full).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (isLink) return undefined;
      const info = yield* fs.stat(full);
      if (info.type !== "File" || Number(info.size) > UNTRACKED_COUNT_LIMIT) {
        return undefined;
      }
      const contents = yield* fs.readFile(full);
      if (contents.subarray(0, BINARY_SNIFF_BYTES).includes(0))
        return undefined;
      let additions = 0;
      for (
        let at = contents.indexOf(0x0a);
        at !== -1;
        at = contents.indexOf(0x0a, at + 1)
      ) {
        additions++;
      }
      // A last line without its newline is still a line.
      if (contents.length > 0 && contents.at(-1) !== 0x0a) additions++;
      return { additions, deletions: 0 } satisfies ChangeCounts;
    }).pipe(
      // Gone since the listing, or unreadable: the row lists without counts.
      Effect.orElseSucceed(() => undefined),
    );
  };

  const changes = Effect.fn("Git.changes")(function* (worktree: string) {
    // One `diff HEAD --numstat` covers everything git knows about, and
    // needs nothing from the listing. New files are counted one at a
    // time, so an unignored build directory holds one file's bytes in
    // memory, not all of them.
    const [files, tracked] = yield* Effect.all(
      [
        status(worktree, "all"),
        run(worktree, [
          "-c",
          "core.quotePath=false",
          "diff",
          "HEAD",
          "--numstat",
          "-z",
        ]).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.map(parseNumstat),
        ),
      ],
      { concurrency: 2 },
    );
    const untracked = new Map(
      yield* Effect.forEach(files.filter(isUntracked), (file) =>
        countUntracked(worktree, file.path).pipe(
          Effect.map((counts) => [file.path, counts] as const),
        ),
      ),
    );
    const counted: ChangedFile[] = [];
    for (const file of files) {
      // By what the row is, not just its path: `git rm --cached f`
      // leaves a staged deletion and an untracked file both called f.
      const counts = isUntracked(file)
        ? untracked.get(file.path)
        : tracked.get(file.path);
      counted.push(counts ? { ...file, counts } : file);
    }
    return counted;
  });

  const workingTreeChanges = Effect.fn("Git.workingTreeChanges")(function* (
    worktree: string,
  ) {
    const files = yield* status(worktree);
    // A deleted path fails its stat and an untracked directory stats as
    // the directory. Either is fine: only the newest hit counts.
    const times = yield* Effect.forEach(
      files.slice(0, CHANGE_MTIME_STATS),
      (file) =>
        fs.stat(path.join(worktree, file.path)).pipe(
          Effect.map((info) =>
            Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (d) => d.getTime(),
            }),
          ),
          Effect.orElseSucceed(() => 0),
        ),
      { concurrency: 8 },
    );
    return { count: files.length, lastChangeAt: Math.max(0, ...times) };
  });

  const changedCount = Effect.fn("Git.changedCount")(function* (
    worktree: string,
  ) {
    return (yield* status(worktree, "normal")).length;
  });

  // --- history ---

  const aheadBehind = Effect.fn("Git.aheadBehind")(function* (
    worktree: string,
    ref: string,
  ) {
    if (ref === "") return Option.none();
    return yield* run(worktree, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${ref}`,
    ]).pipe(
      Effect.map((stdout) => Option.fromUndefinedOr(parseLeftRight(stdout))),
      Effect.orElseSucceed(() => Option.none()),
    );
  });

  const upstreamSync = Effect.fn("Git.upstreamSync")(function* (
    worktree: string,
  ) {
    const counts = yield* aheadBehind(worktree, "@{u}");
    if (Option.isNone(counts)) {
      return { ahead: 0, behind: 0, hasUpstream: false, divergedClean: false };
    }
    const { ahead, behind } = counts.value;
    const divergedClean =
      ahead > 0 &&
      behind > 0 &&
      (yield* succeeds(worktree, [
        "merge-tree",
        "--write-tree",
        "HEAD",
        "@{u}",
      ]));
    return { ahead, behind, hasUpstream: true, divergedClean };
  });

  const unpushedCount = Effect.fn("Git.unpushedCount")(function* (
    worktree: string,
  ) {
    // Against every remote-tracking ref, so a commit pushed under
    // another name counts as shared. An unborn branch has nothing.
    return yield* run(worktree, [
      "rev-list",
      "--count",
      `--max-count=${UNPUSHED_LIMIT}`,
      "HEAD",
      "--not",
      "--remotes",
    ]).pipe(
      Effect.map((stdout) => Number.parseInt(stdout.trim(), 10) || 0),
      Effect.orElseSucceed(() => 0),
    );
  });

  const listCommits = Effect.fn("Git.listCommits")(function* (
    worktree: string,
    page: { readonly skip: number; readonly count: number },
  ) {
    return yield* run(worktree, [
      "log",
      `--skip=${page.skip}`,
      `-${page.count}`,
      `--pretty=format:${LOG_FORMAT}`,
      "--shortstat",
    ]).pipe(
      Effect.map(parseLog),
      Effect.orElseSucceed(() => []),
    );
  });

  const firstParentChain = Effect.fn("Git.firstParentChain")(function* (
    repo: string,
    ref: string,
  ) {
    if (ref === "") return Option.none();
    return yield* run(repo, [
      "rev-list",
      "--first-parent",
      `-n${FIRST_PARENT_LIMIT + 1}`,
      ref,
    ]).pipe(
      Effect.map(
        (stdout): Option.Option<ReadonlySet<string>> =>
          Option.some(new Set(splitLines(stdout))),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
  });

  // Whether the branch's work is in the primary. A branch behind the
  // primary and not ahead is in its history for one of two reasons:
  // its work was merged, or it never left (a worktree made and left
  // while the primary moved on). A merged branch hangs off the
  // primary's first-parent chain and an untouched one sits on it, which
  // keeps idle worktrees out of the merged list. A local fast-forward
  // or rebase merge reads as not landed: its history is identical.
  const primaryRelation = Effect.fn("Git.primaryRelation")(function* (input: {
    readonly worktree: string;
    readonly primaryRef: string;
    readonly chain: Effect.Effect<Option.Option<ReadonlySet<string>>>;
  }) {
    const counts = yield* aheadBehind(input.worktree, input.primaryRef);
    if (Option.isNone(counts))
      return { behindPrimary: 0, mergedIntoPrimary: false };
    const { ahead, behind } = counts.value;
    if (ahead > 0 || behind === 0 || behind > FIRST_PARENT_LIMIT) {
      return { behindPrimary: behind, mergedIntoPrimary: false };
    }
    const head = yield* run(input.worktree, ["rev-parse", "HEAD"]).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
    // An unread chain must read as "not landed": an empty one would put
    // every HEAD off it, i.e. merged.
    const chain = yield* input.chain;
    const merged =
      head !== "" && Option.isSome(chain) && !chain.value.has(head);
    return { behindPrimary: behind, mergedIntoPrimary: merged };
  });

  const readCommitMessage = Effect.fn("Git.readCommitMessage")(function* (
    worktree: string,
    hash: string,
  ) {
    // `%s` and `%b` are git's own split, and a NUL between them survives
    // any subject a person could type.
    const stdout = yield* run(worktree, [
      "show",
      "-s",
      "--format=%s%x00%b",
      "--end-of-options",
      hash,
      "--",
    ]);
    const cut = stdout.indexOf("\0");
    if (cut < 0) return { summary: stdout.trim(), description: "" };
    return {
      summary: stdout.slice(0, cut).trim(),
      description: stdout.slice(cut + 1).trim(),
    };
  });

  // --- refs and objects ---
  // Every caller-supplied revision goes after --end-of-options, so none
  // can be read as a flag.

  const verifyRev = Effect.fn("Git.verifyRev")(function* (
    cwd: string,
    rev: string,
  ) {
    return (yield* run(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      rev,
    ])).trim();
  });

  const refTip = (cwd: string, ref: string) =>
    Effect.option(verifyRev(cwd, ref));

  const hasObject = (cwd: string, object: string) =>
    succeeds(cwd, ["cat-file", "-e", "--end-of-options", object]);

  // merge-base --is-ancestor answers with its exit code: 0 yes, 1 no,
  // anything else a real failure.
  const isAncestor = Effect.fn("Git.isAncestor")(function* (
    cwd: string,
    ancestor: string,
    descendant: string,
  ) {
    return yield* run(cwd, [
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      ancestor,
      descendant,
    ]).pipe(
      Effect.as(true),
      Effect.catchTag("GitCommandError", (error) =>
        error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
  });

  // --- branches and remotes ---

  const branchRefs = Effect.fn("Git.branchRefs")(function* (repo: string) {
    return parseBranchRefs(
      yield* run(repo, [
        "for-each-ref",
        "--format=%(refname) %(symref)",
        "refs/heads",
        "refs/remotes",
      ]),
    );
  });

  // The branches and the default ref picked among them, or none when
  // they can't be read.
  const pickDefault = (
    repo: string,
    override: string | undefined,
    remotes: readonly string[] | undefined,
  ) =>
    Effect.gen(function* () {
      const refs = yield* Effect.option(branchRefs(repo));
      if (Option.isNone(refs)) return Option.none();
      const picked = pickDefaultRef(
        refs.value,
        override,
        remotes ?? (yield* listRemotes(repo)),
      );
      return Option.some({ refs: refs.value, picked });
    });

  const resolveDefaultBranch = Effect.fn("Git.resolveDefaultBranch")(function* (
    repo: string,
    override?: string,
    remotes?: readonly string[],
  ) {
    return Option.flatMap(
      yield* pickDefault(repo, override, remotes),
      ({ refs, picked }) =>
        picked === undefined
          ? Option.fromUndefinedOr(refs.locals[0])
          : Option.some(shortRefName(picked)),
    );
  });

  const resolveDefaultRef = Effect.fn("Git.resolveDefaultRef")(function* (
    repo: string,
    override?: string,
  ) {
    return Option.flatMap(
      yield* pickDefault(repo, override, undefined),
      ({ picked }) => Option.fromUndefinedOr(picked),
    );
  });

  const checkoutBranch = Effect.fn("Git.checkoutBranch")(function* (
    worktree: string,
    branch: string,
    remotes?: readonly string[],
  ) {
    // `git checkout origin/main` would detach HEAD, so a remote ref
    // whose local branch is missing makes it, tracking the qualified
    // ref (unambiguous when several remotes share the name). The
    // trailing `--` keeps the name out of the pathspec slot.
    const { target, track } = yield* resolveCheckoutRef(
      worktree,
      branch,
      remotes,
    );
    yield* run(worktree, [
      "checkout",
      ...(Option.isSome(track) ? ["--track"] : []),
      "--end-of-options",
      target,
      "--",
    ]);
  });

  const createBranch = Effect.fn("Git.createBranch")(function* (input: {
    readonly repo: string;
    readonly name: string;
    readonly base?: string | undefined;
  }) {
    // Tracking set explicitly, so it doesn't hang on the user's
    // branch.autoSetupMerge. A local base (even feature/foo) must not
    // track, which would pin the upstream to a local ref.
    const track = input.base
      ? !(yield* localBranchExists(input.repo, input.base)) &&
        (yield* remoteRefExists(input.repo, input.base))
      : false;
    yield* run(input.repo, [
      "branch",
      ...(track ? ["--track"] : []),
      "--",
      input.name,
      ...(input.base ? [input.base] : []),
    ]);
  });

  const deleteBranch = Effect.fn("Git.deleteBranch")(function* (input: {
    readonly repo: string;
    readonly name: string;
    readonly force: boolean;
  }) {
    yield* run(input.repo, [
      "branch",
      input.force ? "-D" : "-d",
      "--",
      input.name,
    ]).pipe(
      Effect.catchTag(
        "GitCommandError",
        (error): Effect.Effect<never, GitCommandError | BranchNotMergedError> =>
          !input.force && /not fully merged/.test(stderrOf(error))
            ? Effect.fail(new BranchNotMergedError({ branch: input.name }))
            : Effect.fail(error),
      ),
    );
  });

  // `--directory` collapses a fully ignored directory into one
  // trailing-slash entry. -z keeps non-ASCII names raw, so they compare
  // equal to paths read off the disk.
  const listOthersIgnored = (repo: string, exclude: string) =>
    run(repo, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      exclude,
      "--directory",
    ]).pipe(Effect.map(splitZ));

  const listIgnoreRules = Effect.fn("Git.listIgnoreRules")(function* (
    worktree: string,
  ) {
    // Every .gitignore git can see: tracked ones, and untracked ones it
    // doesn't itself ignore. The pathspec's * spans folders.
    const files = yield* run(worktree, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ".gitignore",
      "*/.gitignore",
    ]).pipe(
      Effect.map(splitZ),
      Effect.orElseSucceed(() => [".gitignore"]),
    );
    const readRules = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map(ignoreRulesOf),
        Effect.orElseSucceed(() => []),
      );
    const rules: string[] = [];
    for (const file of files.toSorted()) {
      const folder = path.dirname(file) === "." ? "" : path.dirname(file);
      for (const rule of yield* readRules(path.join(worktree, file))) {
        rules.push(anchorRule(rule, folder));
      }
    }
    // The exclude file lives in the repository's git dir, which a
    // linked worktree only points at. Its rules read like the root's.
    const exclude = yield* run(worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (exclude !== "") rules.push(...(yield* readRules(exclude)));
    return [...new Set(rules)].slice(0, MIRROR_IGNORES_LIMIT);
  });

  // --- the remote ---

  // Overlapping callers share the one in flight, and nothing is kept
  // after it.
  const fetches = yield* Cache.make({
    lookup: (repo: string) =>
      run(repo, ["fetch", "--all", "--quiet", "--prune"]),
    capacity: Number.POSITIVE_INFINITY,
    timeToLive: 0,
  });
  const fetchAll = Effect.fn("Git.fetchAll")(function* (repo: string) {
    yield* Cache.get(fetches, repo);
  });

  // Tries a rebase first for linear history. A conflicting commit
  // aborts it for a whole-tree merge, and a failed merge is aborted
  // too, so the worktree is never left half done. Neither command takes
  // a trailing `--`, which they would read as a second revision.
  const rebaseOrMerge = (worktree: string, ref: string) =>
    run(worktree, ["rebase", "--end-of-options", ref]).pipe(
      Effect.catch(() =>
        Effect.ignore(run(worktree, ["rebase", "--abort"])).pipe(
          Effect.andThen(run(worktree, ["merge", "--end-of-options", ref])),
          Effect.tapError(() =>
            Effect.ignore(run(worktree, ["merge", "--abort"])),
          ),
        ),
      ),
      Effect.asVoid,
    );

  const overwriteFromUpstream = Effect.fn("Git.overwriteFromUpstream")(
    function* (worktree: string) {
      yield* run(worktree, ["fetch"]);
      // The page offers this on a clean worktree, but decides that from a
      // count another process can make stale, and `reset --hard` past
      // uncommitted work leaves nothing to recover.
      const dirty = yield* status(worktree, "normal");
      if (dirty.length > 0) {
        return yield* new OverwriteRefusedError({
          reason: "uncommitted",
          paths: [],
          count: dirty.length,
        });
      }
      // Ignored files never show in status, but `reset --hard` overwrites
      // one wherever the upstream tracks a file at its path, and its
      // content was never in git. With the tree clean, the paths that can
      // collide are the upstream's added files. git says which of those
      // are ignored files here, which a plain exists check would get
      // wrong for a case-only rename on a case-insensitive disk.
      // --no-renames: an upstream rename's destination is an addition.
      const added = splitZ(
        yield* run(worktree, [
          "diff",
          "--name-only",
          "--no-renames",
          "--diff-filter=A",
          "-z",
          "HEAD",
          "@{u}",
        ]),
      );
      const collisions = (yield* Effect.forEach(chunksOf(added), (chunk) =>
        run(worktree, [
          "ls-files",
          "-z",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--",
          ...chunk,
        ]),
      )).flatMap(splitZ);
      if (collisions.length > 0) {
        return yield* new OverwriteRefusedError({
          reason: "ignored-files",
          paths: collisions.slice(0, SHOWN),
          count: collisions.length,
        });
      }
      yield* run(worktree, ["reset", "--hard", "@{u}"]);
    },
  );

  const publish = Effect.fn("Git.publish")(function* (input: {
    readonly worktree: string;
    readonly repo: string;
  }) {
    const [first] = yield* listRemotes(input.repo);
    if (first === undefined) return yield* new NoRemoteError();
    yield* run(input.worktree, ["push", "-u", first, "HEAD"]);
  });

  const clone = Effect.fn("Git.clone")(function* (input: {
    readonly url: string;
    readonly parentDir: string;
    readonly name: string;
  }) {
    // Both checks are for the message: git would refuse either, in
    // words about its own argv.
    const parent = yield* fs.stat(input.parentDir).pipe(Effect.option);
    if (Option.isNone(parent) || parent.value.type !== "Directory") {
      return yield* new CloneDestinationError({
        path: input.parentDir,
        reason: "not-a-folder",
      });
    }
    const dest = path.join(input.parentDir, input.name);
    if (yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) {
      return yield* new CloneDestinationError({ path: dest, reason: "exists" });
    }
    // Nobody may be at a terminal to answer a credential prompt (least
    // of all for a clone asked for from another device), so git's own
    // is off and an unauthenticated remote fails rather than waits.
    yield* run(input.parentDir, ["clone", "--", input.url, input.name], {
      env: { GIT_TERMINAL_PROMPT: "0" },
    }).pipe(
      Effect.mapError((error) =>
        error instanceof GitCommandError
          ? new GitCommandError({
              subcommand: error.subcommand,
              exitCode: error.exitCode,
              cause: new Error(redactUserinfo(stderrOf(error))),
            })
          : error,
      ),
    );
    return dest;
  });

  // --- the index ---

  const setStaged = Effect.fn("Git.setStaged")(function* (input: {
    readonly worktree: string;
    readonly paths: readonly string[];
    readonly staged: boolean;
  }) {
    // `add -A` stages a deleted file as a removal. Unstaging is `reset`
    // rather than `restore --staged`, which refuses a path git doesn't
    // know and an unborn branch. The fresh listing comes from the same
    // slot, so two quick ticks answer in order. No counts: staging
    // moves the index, and the counts compare the tree with HEAD.
    return yield* onIndex(
      input.worktree,
      Effect.gen(function* () {
        yield* runChunked(
          input.worktree,
          input.staged ? ["add", "-A"] : ["reset", "-q"],
          input.paths,
        );
        return yield* status(input.worktree, "all");
      }),
    );
  });

  const commitIndex = Effect.fn("Git.commit")(function* (input: {
    readonly worktree: string;
    readonly summary: string;
    readonly description?: string | undefined;
    readonly amend?: boolean | undefined;
    readonly stagePaths?: readonly string[] | undefined;
  }) {
    return yield* onIndex(
      input.worktree,
      Effect.gen(function* () {
        if (input.stagePaths && input.stagePaths.length > 0) {
          yield* runChunked(input.worktree, ["add", "-A"], input.stagePaths);
        }
        // Two -m flags make the summary and body separate paragraphs.
        const body = input.description?.trim();
        yield* run(input.worktree, [
          "commit",
          "--quiet",
          ...(input.amend ? ["--amend"] : []),
          "-m",
          input.summary,
          ...(body ? ["-m", body] : []),
        ]);
        return (yield* run(input.worktree, [
          "rev-parse",
          "--short",
          "HEAD",
        ])).trim();
      }),
    );
  });

  const resetSoft = Effect.fn("Git.resetSoft")(function* (input: {
    readonly worktree: string;
    readonly target: string;
    readonly expectHead?: string | undefined;
  }) {
    const { worktree, target, expectHead } = input;
    return yield* onIndex(
      worktree,
      Effect.gen(function* () {
        const head = yield* verifyRev(worktree, "HEAD");
        if (
          expectHead !== undefined &&
          head !== (yield* verifyRev(worktree, expectHead))
        ) {
          return yield* new UndoRefusedError({ reason: "moved" });
        }
        // Anything committed since makes it a different line, and a
        // revision that doesn't resolve is off it too.
        const onLine = (a: string, b: string) =>
          isAncestor(worktree, a, b).pipe(Effect.orElseSucceed(() => false));
        const range = (yield* onLine(target, head))
          ? [target, head]
          : expectHead !== undefined && (yield* onLine(head, target))
            ? [head, target]
            : undefined;
        if (range === undefined) {
          return yield* new UndoRefusedError({ reason: "off-history" });
        }
        // Soft-resetting past a merge stages its whole other side as
        // edits, which is nothing anyone means by undo.
        const [older, newer] = range;
        const merges = yield* run(worktree, [
          "rev-list",
          "--merges",
          "--count",
          "--end-of-options",
          `${older}..${newer}`,
        ]);
        if (merges.trim() !== "0") {
          return yield* new UndoRefusedError({ reason: "across-merge" });
        }
        yield* run(worktree, ["reset", "--soft", "--end-of-options", target]);
        return head;
      }),
    );
  });

  // A commit of `paths` as they are on disk now, under
  // DISCARD_REF_PREFIX, built in a scratch index so the real one is
  // untouched. The ref keeps its objects through gc, and the newest
  // DISCARD_SNAPSHOTS_KEPT are kept.
  const snapshotPaths = (worktree: string, paths: readonly string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        // No temp dir means a broken machine, not a refusal to discard.
        const scratch = yield* fs
          .makeTempDirectoryScoped({ prefix: "shigomori-discard-" })
          .pipe(Effect.orDie);
        const env = {
          GIT_INDEX_FILE: path.join(scratch, "index"),
          // The snapshot's own identity, so a repo without user.name can
          // still discard safely.
          GIT_AUTHOR_NAME: "Shigoto no Mori",
          GIT_AUTHOR_EMAIL: "shigomori@localhost",
          GIT_COMMITTER_NAME: "Shigoto no Mori",
          GIT_COMMITTER_EMAIL: "shigomori@localhost",
        };
        const head = yield* refTip(worktree, "HEAD");
        // An unborn branch has no tree to start from: the snapshot is a
        // root commit of just the discarded files.
        yield* run(
          worktree,
          Option.isSome(head)
            ? ["read-tree", "HEAD"]
            : ["read-tree", "--empty"],
          { env },
        );
        yield* runChunked(worktree, ["add", "-A"], paths, { env });
        const tree = (yield* run(worktree, ["write-tree"], { env })).trim();
        const message = `Discarded from ${path.basename(worktree)}: ${paths.length} file${paths.length === 1 ? "" : "s"}`;
        const snapshot = (yield* run(
          worktree,
          [
            "commit-tree",
            tree,
            "-m",
            message,
            ...(Option.isSome(head) ? ["-p", head.value] : []),
          ],
          { env },
        )).trim();
        yield* run(worktree, [
          "update-ref",
          `${DISCARD_REF_PREFIX}${yield* Clock.currentTimeMillis}`,
          snapshot,
        ]);
        // Ref names are equal-width millisecond stamps, so a reverse name
        // sort is newest first. Best effort: a failed prune leaves a ref.
        yield* run(worktree, [
          "for-each-ref",
          "--format=%(refname)",
          "--sort=-refname",
          DISCARD_REF_PREFIX,
        ]).pipe(
          Effect.flatMap((stdout) =>
            Effect.forEach(
              splitLines(stdout).slice(DISCARD_SNAPSHOTS_KEPT),
              (ref) => run(worktree, ["update-ref", "-d", ref]),
            ),
          ),
          Effect.ignore,
        );
        return snapshot;
      }),
    );

  const discard = Effect.fn("Git.discard")(function* (input: {
    readonly worktree: string;
    readonly paths: readonly string[];
  }) {
    const { worktree, paths } = input;
    return yield* onIndex(
      worktree,
      Effect.gen(function* () {
        // Without its snapshot the discard is off: that would be the
        // only copy of the work.
        const snapshot = yield* snapshotPaths(worktree, paths);
        // Unstaged first (a staged addition becomes untracked, a staged
        // deletion comes back), then whatever the index knows is
        // restored and the rest, the untracked set, is cleaned. Two
        // lists, since `restore` refuses paths git doesn't know and
        // `clean` ignores paths it does.
        yield* runChunked(worktree, ["reset", "-q"], paths);
        const tracked = new Set(
          (yield* runChunked(worktree, ["ls-files", "-z"], paths)).flatMap(
            splitZ,
          ),
        );
        const untracked = paths.filter((p) => !tracked.has(p));
        if (tracked.size > 0)
          yield* runChunked(worktree, ["restore", "--worktree"], [...tracked]);
        if (untracked.length > 0) {
          // -d: an untracked path can be the last file in a new folder.
          yield* runChunked(worktree, ["clean", "-fdq"], untracked);
          const left = (yield* runChunked(
            worktree,
            ["ls-files", "-z", "--others", "--exclude-standard"],
            untracked,
          )).flatMap(splitZ);
          if (left.length > 0) {
            return yield* new NestedRepositoryError({
              paths: left.slice(0, SHOWN),
              count: left.length,
            });
          }
        }
        return snapshot;
      }),
    );
  });

  const restoreDiscard = Effect.fn("Git.restoreDiscard")(function* (input: {
    readonly worktree: string;
    readonly snapshot: string;
  }) {
    const { worktree, snapshot } = input;
    yield* onIndex(
      worktree,
      Effect.gen(function* () {
        // The snapshot's diff against its parent is exactly what went.
        // --root diffs a parentless one (an unborn-branch discard)
        // against the empty tree.
        const fields = splitZ(
          yield* run(worktree, [
            "diff-tree",
            "-r",
            "-z",
            "--root",
            "--no-commit-id",
            "--no-renames",
            "--name-status",
            "--end-of-options",
            snapshot,
            "--",
          ]),
        );
        const restore: string[] = [];
        const remove: string[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const [state, file] = [fields[i], fields[i + 1]];
          if (!state || !file) continue;
          (state.startsWith("D") ? remove : restore).push(file);
        }
        if (restore.length > 0) {
          yield* runChunked(
            worktree,
            ["restore", "--worktree", `--source=${snapshot}`],
            restore,
          );
        }
        yield* Effect.forEach(remove, (file) =>
          fs
            .remove(path.join(worktree, file), { force: true })
            .pipe(Effect.ignore),
        );
      }),
    );
  });

  // --- diffs ---

  const fileDiff = Effect.fn("Git.fileDiff")(function* (input: {
    readonly worktree: string;
    readonly paths: readonly string[];
    readonly untracked: boolean;
  }) {
    const { worktree, paths, untracked } = input;
    const file = paths.at(-1);
    if (file === undefined) return "";
    // A path is a filename, never a pattern: otherwise `a[1].txt` is a
    // glob, and the pane for one file answers with another's hunks.
    const pathspec = ["-c", "core.quotePath=false", "--literal-pathspecs"];
    // `--no-index` reads straight off the disk, so it would answer for a
    // path git doesn't count as a change (an ignored .env). Read-only
    // peers reach this, so git says first whether it is an untracked
    // change. A symlink prints where it points, never what is there.
    if (untracked) {
      const known = yield* run(worktree, [
        ...pathspec,
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        file,
      ]).pipe(Effect.orElseSucceed(() => ""));
      if (known === "") return "";
    }
    return yield* run(
      worktree,
      [
        ...pathspec,
        ...(untracked
          ? ["diff", "--no-index", "--no-color", "--", "/dev/null", file]
          : ["diff", "HEAD", "--no-color", "--", ...paths]),
      ],
      { okExitCodes: [1], maxOutputBytes: PATCH_MAX_OUTPUT },
    ).pipe(Effect.catchTag("GitCommandError", () => Effect.succeed("")));
  });

  return Git.of({
    run,
    isRepo: (repo) => succeeds(repo, ["rev-parse", "--git-dir"]),
    listWorktrees,
    addWorktree,
    checkoutWorktree,
    removeWorktree,
    pruneWorktrees,
    status,
    changes,
    workingTreeChanges,
    changedCount,
    aheadBehind,
    upstreamSync,
    unpushedCount,
    listCommits,
    firstParentChain,
    primaryRelation,
    readCommitMessage,
    refTip,
    verifyRev,
    treeOf: (cwd, commit) => verifyRev(cwd, `${commit}^{tree}`),
    hasObject,
    hasCommit: (cwd, commit) => hasObject(cwd, `${commit}^{commit}`),
    isAncestor,
    updateRef: Effect.fn("Git.updateRef")(function* (input) {
      yield* run(input.repo, [
        "update-ref",
        "--end-of-options",
        input.ref,
        input.commit,
        ...(input.expected === undefined ? [] : [input.expected]),
      ]);
    }),
    deleteRef: Effect.fn("Git.deleteRef")(function* (repo, ref) {
      yield* run(repo, ["update-ref", "-d", "--end-of-options", ref]);
    }),
    localBranchTips: Effect.fn("Git.localBranchTips")(function* (repo) {
      const tips = splitLines(
        yield* run(repo, [
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/",
        ]),
      );
      return [...new Set(tips)].slice(0, LOCAL_TIPS_LIMIT);
    }),
    snapshotRemoteRefs: (repo) =>
      run(repo, [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/remotes/",
      ]),
    listRemotes,
    listRemoteEntries: Effect.fn("Git.listRemoteEntries")(function* (repo) {
      return yield* run(repo, ["remote", "-v"]).pipe(
        Effect.map(parseRemoteEntries),
        Effect.orElseSucceed(() => []),
      );
    }),
    branchRefs,
    listBranches: (repo) => branchRefs(repo).pipe(Effect.map(branchListOf)),
    localBranchExists,
    remoteRefExists,
    resolveDefaultRef,
    resolveDefaultBranch,
    resolveCheckoutRef,
    checkoutBranch,
    createBranch,
    renameCurrentBranch: Effect.fn("Git.renameCurrentBranch")(
      function* (worktree, name) {
        yield* run(worktree, ["branch", "-m", "--", name]);
      },
    ),
    renameBranch: Effect.fn("Git.renameBranch")(function* (input) {
      yield* run(input.repo, ["branch", "-m", "--", input.from, input.to]);
    }),
    deleteBranch,
    listIgnoredPaths: (repo) => listOthersIgnored(repo, "--exclude-standard"),
    listUntrackedMatching: (repo, excludeFile) =>
      listOthersIgnored(repo, `--exclude-from=${excludeFile}`),
    listIgnoreRules,
    fetchAll,
    push: Effect.fn("Git.push")(function* (worktree) {
      yield* run(worktree, ["push"]);
    }),
    pushForceWithLease: Effect.fn("Git.pushForceWithLease")(
      function* (worktree) {
        yield* run(worktree, ["push", "--force-with-lease"]);
      },
    ),
    pullFastForward: Effect.fn("Git.pullFastForward")(function* (worktree) {
      yield* run(worktree, ["pull", "--ff-only"]);
    }),
    fastForwardToUpstream: Effect.fn("Git.fastForwardToUpstream")(
      function* (worktree) {
        yield* run(worktree, ["merge", "--ff-only", "@{u}"]);
      },
    ),
    overwriteFromUpstream,
    publish,
    // The merge-tree probe that offers this already found the
    // whole-tree merge clean, which is what makes the fallback safe.
    pullRebaseOrMergeAndPush: Effect.fn("Git.pullRebaseOrMergeAndPush")(
      function* (worktree) {
        yield* run(worktree, ["fetch"]);
        yield* rebaseOrMerge(worktree, "@{u}");
        yield* run(worktree, ["push"]);
      },
    ),
    syncWithPrimary: Effect.fn("Git.syncWithPrimary")(function* (input) {
      yield* fetchAll(input.repo);
      yield* rebaseOrMerge(input.worktree, input.primaryRef);
    }),
    clone,
    setStaged,
    commit: commitIndex,
    resetSoft,
    discard,
    restoreDiscard,
    fileDiff,
    // --format= drops the commit header, so the patch parses as is.
    // Empty for a commit git can't show one for.
    commitDiff: (worktree, hash) =>
      run(
        worktree,
        ["show", "--format=", "--no-color", "--end-of-options", hash, "--"],
        {
          maxOutputBytes: PATCH_MAX_OUTPUT,
        },
      ).pipe(Effect.catchTag("GitCommandError", () => Effect.succeed(""))),
    // Both have to be commits the repository already holds.
    mergeBaseDiff: (input) =>
      run(
        input.repo,
        [
          "diff",
          "--no-color",
          "--end-of-options",
          `${input.base}...${input.head}`,
        ],
        {
          maxOutputBytes: PATCH_MAX_OUTPUT,
        },
      ),
  });
});

export const layer = Layer.effect(Git, make);
