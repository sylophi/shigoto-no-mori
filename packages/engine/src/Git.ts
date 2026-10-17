// Every git the engine runs, and what it reads out of it: the probes a
// worktree row is built from, refs and branches, the remote sync, the
// changes page's index work, and the diffs. One runner under all of
// it, so the spawn cap, the locale and the errors are the same for
// every caller.
import type {
  BranchHistory,
  BranchList,
  ChangedFile,
  CommitMessage,
  CommitSummary,
  FileHunks,
  GitOperationState,
  IntegrateMethod,
  LineChange,
  MergePreview,
  StashEntry,
} from "@shigomori/contracts/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import {
  type BranchRefs,
  parseBranchList,
  parseRemoteEntries,
  splitLines,
  type WorktreeEntry,
} from "./gitParse.ts";
import { makeRunning } from "./git/running.ts";
import { makeWorktreeVerbs } from "./git/worktreeVerbs.ts";
import { makeWorkingTree } from "./git/workingTree.ts";
import { makeHistory } from "./git/history.ts";
import { makeRefs } from "./git/refs.ts";
import { makeBranches } from "./git/branches.ts";
import { makeRemote } from "./git/remote.ts";
import { makeGitIndex } from "./git/gitIndex.ts";
import { makeDiffs } from "./git/diffs.ts";
import { makeRepositories } from "./git/repositories.ts";
import { makeOperation } from "./git/operation.ts";
import { makeHunks } from "./git/hunks.ts";
import { makeCommit } from "./git/commit.ts";
import { makeStash } from "./git/stash.ts";
import { makeMerging } from "./git/merging.ts";
import { makeRewriting } from "./git/rewriting.ts";
import type { SyncConflictsError } from "@shigomori/contracts/errors";
import {
  type BranchMovedError,
  BranchNotMergedError,
  CloneDestinationError,
  type CommitRequest,
  type GitError,
  type GitOutputTooLargeError,
  type GitRefusedError,
  LOCAL_TIPS_LIMIT,
  NestedRepositoryError,
  NoRemoteError,
  PATCH_CONFIG,
  PATCH_FLAGS,
  PATCH_MAX_OUTPUT,
  type PrimaryRelation,
  type RunOptions,
  UndoRefusedError,
  type UnknownRevisionError,
  type UpstreamSync,
} from "./git/documents.ts";
export {
  BranchMovedError,
  GitRefusedError,
  BranchNotMergedError,
  CloneDestinationError,
  DISCARD_REF_PREFIX,
  GitCommandError,
  GitOutputTooLargeError,
  NestedRepositoryError,
  NoRemoteError,
  UndoRefusedError,
  PATHSPEC_CHUNK,
  UnknownRevisionError,
  ZERO_SHA,
  stderrOf,
} from "./git/documents.ts";
export type {
  CommitRequest,
  GitError,
  PrimaryRelation,
  RunOptions,
  UpstreamSync,
} from "./git/documents.ts";

export class Git extends Context.Service<
  Git,
  {
    // The one way to run git. Everything below goes through it.
    readonly run: (
      cwd: string,
      args: readonly string[],
      options?: RunOptions,
    ) => Effect.Effect<string, GitError>;
    // A file of the repository's git dir (`index`, `info/exclude`, a
    // hook) as an absolute path, as git resolves it for `cwd`.
    readonly gitPath: (
      cwd: string,
      name: string,
    ) => Effect.Effect<string, GitError>;
    // What git printed, whatever its exit, for a read that has an answer
    // either way. A git that never ran answers empty, and output past
    // the cap still fails.
    readonly runLenient: (
      cwd: string,
      args: readonly string[],
      options?: RunOptions,
    ) => Effect.Effect<string, GitOutputTooLargeError>;
    readonly isRepo: (path: string) => Effect.Effect<boolean>;
    // Runs `task` while no other write to `worktree`'s index runs: git
    // takes index.lock for each, so two would otherwise fail on the lock
    // instead of waiting. Every index write below takes it.
    readonly withIndexLock: <A, E, R>(
      worktree: string,
      task: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    // The checkout `dir` is in, its repository's common dir and its
    // primary checkout, from one git: the common dir points at the
    // primary's .git even from a linked worktree. None outside a
    // repository.
    readonly locate: (dir: string) => Effect.Effect<
      Option.Option<{
        readonly toplevel: string;
        readonly commonDir: string;
        readonly primaryPath: string;
      }>
    >;

    // --- worktrees ---
    // The admin dir a linked checkout's .git file names, none for a
    // primary checkout (whose .git is a directory) or a folder git never
    // registered.
    readonly adminDirOf: (
      worktreePath: string,
    ) => Effect.Effect<Option.Option<string>>;
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
    // Hides each path (relative to the repository's root) from git
    // status through the repository's info/exclude, skipping one already
    // there. Best effort: the file holds the user's own lines too.
    readonly appendExcludes: (
      repo: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<void>;

    // --- the working tree ---
    // Every changed file. `untracked: "normal"` sees untracked files
    // even where the user turned them off (`status.showUntrackedFiles
    // no`), for the guards ahead of an overwrite or a removal. "all"
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
    // `query` searches the messages (literal, case blind) and `from`
    // starts somewhere other than HEAD. A merge's lines are counted
    // against its first parent, what it brought in.
    readonly listCommits: (
      worktree: string,
      page: {
        readonly skip: number;
        readonly count: number;
        readonly query?: string | undefined;
        readonly from?: string | undefined;
      },
    ) => Effect.Effect<CommitSummary[]>;
    // The branch's own commits back to where it left `base`, and how it
    // stands against its upstream: what the Git page's History tab draws.
    readonly readBranchHistory: (
      worktree: string,
      opts: { readonly base: string | undefined; readonly count: number },
    ) => Effect.Effect<BranchHistory, GitError>;
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
    // The commit `ref` names, refused when there is none.
    readonly resolveCommit: (
      cwd: string,
      ref: string,
    ) => Effect.Effect<string, GitError | UnknownRevisionError>;
    // HEAD, refused where it has moved on from `expectHead`.
    readonly headAt: (
      cwd: string,
      expectHead: string | undefined,
    ) => Effect.Effect<string, GitError | BranchMovedError>;
    // The upstream by its name ("origin/feature"), none without one.
    readonly upstreamName: (
      cwd: string,
    ) => Effect.Effect<Option.Option<string>>;
    // How many commits `revs` name, rev-list's own `flags` applied.
    readonly countCommits: (
      cwd: string,
      revs: readonly string[],
      flags?: readonly string[],
    ) => Effect.Effect<number, GitError>;
    // HEAD's own commits past `ref`: how many, how many of them are
    // merges, and how many no remote has.
    readonly ownCommitCounts: (
      cwd: string,
      ref: string,
    ) => Effect.Effect<
      { own: number; merges: number; unpushed: number },
      GitError
    >;
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
    // What to hand git so a checkout of `ref` lands on a branch. An
    // exact local branch wins. A qualified remote ref resolves to its
    // local branch where that exists, and otherwise stays the ref, with
    // `track` naming the tracking branch to create from it. Anything
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
    ) => Effect.Effect<
      void,
      | GitError
      | GitRefusedError
      | BranchMovedError
      | UnknownRevisionError
      | PlatformError.PlatformError
    >;
    // Uncommitted changes, untracked files included whatever the user's
    // status setting says.
    readonly hasUncommittedOrUntracked: (
      worktree: string,
    ) => Effect.Effect<boolean, GitError>;
    // Pushes the current branch to the repository's first remote and
    // tracks it there.
    readonly publish: (input: {
      readonly worktree: string;
      readonly repo: string;
    }) => Effect.Effect<void, GitError | NoRemoteError>;
    // The diverged-but-mergeable resolution: fetch, rebase onto the
    // upstream where that is safe or merge, push. A merge that conflicts
    // fails with SyncConflictsError.
    readonly pullRebaseOrMergeAndPush: (
      worktree: string,
    ) => Effect.Effect<void, GitError | SyncConflictsError>;
    // Brings the primary ref's commits in the same way, after fetching
    // every remote (the primary can live on another remote than the
    // branch tracks).
    readonly syncWithPrimary: (input: {
      readonly worktree: string;
      readonly repo: string;
      readonly primaryRef: string;
    }) => Effect.Effect<void, GitError | SyncConflictsError>;
    // The way on from a sync that conflicts: the merge, left stopped on
    // its conflicts. Whether it stopped.
    readonly mergeUpstreamKeepingConflicts: (
      worktree: string,
    ) => Effect.Effect<
      boolean,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    readonly mergePrimaryKeepingConflicts: (input: {
      readonly worktree: string;
      readonly repo: string;
      readonly primaryRef: string;
    }) => Effect.Effect<
      boolean,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;

    // --- merges and rewrites ---
    // How far apart HEAD and `ref` are, and which files a merge would
    // conflict on (none read when `countsOnly`).
    readonly readMergePreview: (
      worktree: string,
      ref: string,
      countsOnly?: boolean,
    ) => Effect.Effect<MergePreview, GitError | UnknownRevisionError>;
    // Brings `ref` in by `method`. Whether it stopped on conflicts.
    readonly mergeBranch: (input: {
      readonly worktree: string;
      readonly ref: string;
      readonly method: IntegrateMethod;
      readonly message?: string | undefined;
    }) => Effect.Effect<
      boolean,
      | GitError
      | GitRefusedError
      | UnknownRevisionError
      | PlatformError.PlatformError
    >;
    readonly revertCommit: (
      worktree: string,
      hash: string,
    ) => Effect.Effect<
      void,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    readonly cherryPickCommit: (
      worktree: string,
      hash: string,
    ) => Effect.Effect<
      void,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    // Rewrites `hash`'s message, its descendants rebuilt on top.
    readonly rewordCommit: (input: {
      readonly worktree: string;
      readonly hash: string;
      readonly summary: string;
      readonly description?: string | undefined;
      readonly expectHead: string;
    }) => Effect.Effect<
      void,
      | GitError
      | GitRefusedError
      | BranchMovedError
      | PlatformError.PlatformError
    >;
    // Folds `hash` into the commit before it.
    readonly squashIntoParent: (
      worktree: string,
      hash: string,
      expectHead: string,
    ) => Effect.Effect<
      void,
      | GitError
      | GitRefusedError
      | BranchMovedError
      | PlatformError.PlatformError
    >;
    // `parentDir/name`, refused unless the parent is a folder and the
    // destination is not there yet: where a new checkout may land.
    readonly checkDestination: (
      parentDir: string,
      name: string,
    ) => Effect.Effect<
      string,
      CloneDestinationError | PlatformError.PlatformError
    >;
    // Clones `url` into `parentDir/name` and returns the checkout, with
    // `config` (git's key and value) in the clone's own config. Git
    // never prompts for credentials here, and a URL's userinfo stays
    // out of the error.
    readonly clone: (input: {
      readonly url: string;
      readonly parentDir: string;
      readonly name: string;
      readonly config?: ReadonlyArray<readonly [string, string]> | undefined;
    }) => Effect.Effect<
      string,
      GitError | CloneDestinationError | PlatformError.PlatformError
    >;
    // A repository at `parentDir/name` on the user's default branch
    // (main without one), with an empty first commit, and its path.
    readonly createRepository: (
      parentDir: string,
      name: string,
    ) => Effect.Effect<
      string,
      GitError | CloneDestinationError | PlatformError.PlatformError
    >;

    // --- an operation under way ---
    // The worktree's own git dir.
    readonly gitDir: (worktree: string) => Effect.Effect<string, GitError>;
    readonly conflictedPaths: (
      worktree: string,
    ) => Effect.Effect<string[], GitError>;
    readonly hasStagedChanges: (
      worktree: string,
    ) => Effect.Effect<boolean, GitError>;
    // The operation under way in the worktree whose git dir this is
    // ("merge", "rebase", "cherry-pick", ...), or null.
    readonly operationInProgress: (
      gitDir: string,
    ) => Effect.Effect<string | null>;
    // The operation under way, whether it can be continued, how many
    // files are conflicted, and a rebase's branch.
    readonly readOperation: (
      worktree: string,
    ) => Effect.Effect<
      GitOperationState,
      GitError | PlatformError.PlatformError
    >;
    // Refused while an operation is under way or files are conflicted.
    readonly refuseMidOperation: (
      worktree: string,
    ) => Effect.Effect<
      void,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    readonly continueOperation: (
      worktree: string,
    ) => Effect.Effect<
      void,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    readonly abortOperation: (
      worktree: string,
    ) => Effect.Effect<
      void,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    // Settles one conflicted file with one side's version, or as it
    // stands, and stages it.
    readonly resolveConflict: (input: {
      readonly worktree: string;
      readonly path: string;
      readonly side: "mine" | "theirs" | "as-is";
    }) => Effect.Effect<void, GitError>;

    // --- the index ---
    // `reset --soft` along HEAD's own line: back to an ancestor (an
    // undo), or forward to a descendant when `expectHead` pins where
    // HEAD must still be (its redo). Answers with where HEAD was.
    readonly resetSoft: (input: {
      readonly worktree: string;
      readonly target: string;
      readonly expectHead?: string | undefined;
    }) => Effect.Effect<
      string,
      | GitError
      | UndoRefusedError
      | BranchMovedError
      | GitRefusedError
      | PlatformError.PlatformError
    >;
    // `reset --hard` to `ref`, after keeping what it would overwrite in a
    // discard snapshot. With `restore`, the undo of one: back, and that
    // reset's snapshot put back.
    readonly resetHard: (input: {
      readonly worktree: string;
      readonly ref: string;
      readonly expectHead?: string | undefined;
      readonly restore?: string | undefined;
    }) => Effect.Effect<
      { previousHead: string; head: string; snapshot: string | null },
      | GitError
      | GitRefusedError
      | BranchMovedError
      | UnknownRevisionError
      | PlatformError.PlatformError
    >;
    // `paths` as they are on disk now, kept in a snapshot commit under
    // DISCARD_REF_PREFIX, and the commit.
    readonly snapshotPaths: (
      worktree: string,
      paths: readonly string[],
    ) => Effect.Effect<string, GitError>;
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
    }) => Effect.Effect<void, GitError | PlatformError.PlatformError>;

    // --- hunks, the commit, stashes ---
    // One modified file's changes against HEAD, and HEAD itself, for
    // the page to tick one at a time.
    readonly readHunks: (
      worktree: string,
      path: string,
    ) => Effect.Effect<FileHunks, GitError | PlatformError.PlatformError>;
    // Throws the picked changes of one file away, after a snapshot of
    // it, and answers with the snapshot.
    readonly discardHunks: (input: {
      readonly worktree: string;
      readonly path: string;
      readonly changes: readonly LineChange[];
    }) => Effect.Effect<
      string,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    // A commit of the ticked files and hunks, whatever was staged, and
    // the new commit (short).
    readonly commitPicks: (
      worktree: string,
      message: CommitRequest,
    ) => Effect.Effect<
      string,
      GitError | GitRefusedError | PlatformError.PlatformError
    >;
    // The stashes made on `branch`.
    readonly listStashes: (
      worktree: string,
      branch: string,
    ) => Effect.Effect<StashEntry[], GitError>;
    readonly stashChanges: (
      worktree: string,
      message: string | undefined,
    ) => Effect.Effect<void, GitError>;
    // With `drop`, a pop: the stash goes only once it applied cleanly.
    readonly applyStash: (input: {
      readonly worktree: string;
      readonly hash: string;
      readonly drop: boolean;
    }) => Effect.Effect<void, GitError | GitRefusedError>;
    readonly dropStash: (
      worktree: string,
      hash: string,
    ) => Effect.Effect<void, GitError | GitRefusedError>;
    // Lists a dropped stash again, under its subject.
    readonly restoreStash: (input: {
      readonly worktree: string;
      readonly branch: string;
      readonly hash: string;
      readonly message: string;
      readonly named: boolean;
    }) => Effect.Effect<void, GitError>;
    readonly readStashDiff: (
      worktree: string,
      hash: string,
    ) => Effect.Effect<string, GitError | GitRefusedError>;

    // --- diffs ---
    // One file's diff: against HEAD for a tracked file (`paths` leads
    // with its old name for a rename), against nothing for an untracked
    // one, which must be an untracked change git lists.
    readonly fileDiff: (input: {
      readonly worktree: string;
      readonly paths: readonly string[];
      readonly untracked: boolean;
    }) => Effect.Effect<string, GitError>;
    // A blob by the id a patch names, up to `maxBytes`, past which its
    // size alone. None when the repository holds no such blob (a pull
    // request's head nobody fetched, a working-tree side git never
    // stored).
    readonly readBlob: (input: {
      readonly repo: string;
      readonly oid: string;
      readonly maxBytes: number;
    }) => Effect.Effect<
      Option.Option<{
        readonly size: number;
        readonly bytes: Uint8Array | undefined;
      }>,
      GitError
    >;
    // Whether `path` in the worktree is the blob `oid` names, up to
    // `maxBytes`: a working-tree patch's new side, which git names by the
    // id it would have.
    readonly isWorkingTreeBlob: (input: {
      readonly worktree: string;
      readonly oid: string;
      readonly path: string;
      readonly maxBytes: number;
    }) => Effect.Effect<boolean>;
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

const make = Effect.gen(function* () {
  const running = yield* makeRunning;
  const worktreeVerbs = yield* makeWorktreeVerbs({ running });
  const workingTree = yield* makeWorkingTree({ running });
  const refs = yield* makeRefs({ running });
  const history = yield* makeHistory({ running, refs });
  const branches = yield* makeBranches({ running, worktreeVerbs });
  const operation = yield* makeOperation({ running });
  const gitIndex = yield* makeGitIndex({
    running,
    refs,
    operation,
    workingTree,
  });
  const merging = yield* makeMerging({ running, refs, operation });
  const rewriting = yield* makeRewriting({ running, refs, operation });
  const remote = yield* makeRemote({
    running,
    worktreeVerbs,
    refs,
    operation,
    gitIndex,
    merging,
  });
  const diffs = yield* makeDiffs({ running });
  const { checkDestination, clone, createRepository } = yield* makeRepositories(
    { running },
  );
  const { run, runLenient, succeeds, onIndex } = running;
  const {
    listWorktrees,
    addWorktree,
    listRemotes,
    localBranchExists,
    remoteRefExists,
    resolveCheckoutRef,
    checkoutWorktree,
    removeWorktree,
    pruneWorktrees,
  } = worktreeVerbs;
  const { status, changes, workingTreeChanges, changedCount } = workingTree;
  const {
    aheadBehind,
    upstreamSync,
    unpushedCount,
    listCommits,
    readBranchHistory,
    firstParentChain,
    primaryRelation,
    readCommitMessage,
  } = history;
  const {
    verifyRev,
    refTip,
    hasObject,
    isAncestor,
    resolveCommit,
    headAt,
    upstreamName,
    countCommits,
    ownCommitCounts,
  } = refs;
  const {
    branchRefs,
    appendExcludes,
    resolveDefaultBranch,
    resolveDefaultRef,
    checkoutBranch,
    createBranch,
    deleteBranch,
    listOthersIgnored,
    listIgnoreRules,
  } = branches;
  const { fetchAll, overwriteFromUpstream, publish } = remote;
  const { resetSoft, resetHard, snapshotPaths, discard, restoreDiscard } =
    gitIndex;
  const hunks = yield* makeHunks({ running, gitIndex });
  const { commitPicks } = yield* makeCommit({ running, hunks });
  const stash = yield* makeStash({ running, operation });
  const { fileDiff, readBlob, isWorkingTreeBlob } = diffs;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Git.of({
    run,
    gitPath: running.gitPath,
    runLenient,
    withIndexLock: onIndex,
    ...operation,
    readHunks: hunks.readHunks,
    discardHunks: hunks.discardHunks,
    commitPicks,
    ...stash,
    ...rewriting,
    readMergePreview: merging.readMergePreview,
    mergeBranch: merging.mergeBranch,
    pullRebaseOrMergeAndPush: remote.pullRebaseOrMergeAndPush,
    syncWithPrimary: remote.syncWithPrimary,
    mergeUpstreamKeepingConflicts: remote.mergeUpstreamKeepingConflicts,
    mergePrimaryKeepingConflicts: remote.mergePrimaryKeepingConflicts,
    hasUncommittedOrUntracked: remote.hasUncommittedOrUntracked,
    readBranchHistory,
    adminDirOf: Effect.fn("Git.adminDirOf")((worktreePath: string) =>
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
      ),
    ),
    isRepo: Effect.fn("Git.isRepo")(function* (repo) {
      return yield* succeeds(repo, ["rev-parse", "--git-dir"]);
    }),
    locate: Effect.fn("Git.locate")((dir: string) =>
      run(dir, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ]).pipe(
        Effect.map((stdout) => {
          const [toplevel, commonDir] = stdout.trim().split("\n");
          if (toplevel === undefined || commonDir === undefined) {
            return Option.none();
          }
          const common = commonDir.trim();
          return Option.some({
            toplevel: toplevel.trim(),
            commonDir: common,
            primaryPath:
              path.basename(common) === ".git" ? path.dirname(common) : common,
          });
        }),
        Effect.orElseSucceed(() => Option.none()),
      ),
    ),
    listWorktrees,
    addWorktree,
    checkoutWorktree,
    removeWorktree,
    pruneWorktrees,
    appendExcludes,
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
    treeOf: Effect.fn("Git.treeOf")(function* (cwd, commit) {
      return yield* verifyRev(cwd, `${commit}^{tree}`);
    }),
    hasObject,
    hasCommit: Effect.fn("Git.hasCommit")(function* (cwd, commit) {
      return yield* hasObject(cwd, `${commit}^{commit}`);
    }),
    isAncestor,
    resolveCommit,
    headAt,
    upstreamName,
    countCommits,
    ownCommitCounts,
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
    snapshotRemoteRefs: Effect.fn("Git.snapshotRemoteRefs")(function* (repo) {
      return yield* run(repo, [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/remotes/",
      ]);
    }),
    listRemotes,
    listRemoteEntries: Effect.fn("Git.listRemoteEntries")(function* (repo) {
      return yield* run(repo, ["remote", "-v"]).pipe(
        Effect.map(parseRemoteEntries),
        Effect.orElseSucceed(() => []),
      );
    }),
    branchRefs,
    listBranches: Effect.fn("Git.listBranches")(function* (repo) {
      return parseBranchList(
        yield* run(repo, [
          "for-each-ref",
          "--format=%(refname)\t%(refname:short)\t%(symref)",
          "refs/heads/",
          "refs/remotes/",
        ]),
      );
    }),
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
    listIgnoredPaths: Effect.fn("Git.listIgnoredPaths")(function* (repo) {
      return yield* listOthersIgnored(repo, "--exclude-standard");
    }),
    listUntrackedMatching: Effect.fn("Git.listUntrackedMatching")(
      function* (repo, excludeFile) {
        return yield* listOthersIgnored(repo, `--exclude-from=${excludeFile}`);
      },
    ),
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
    checkDestination,
    clone,
    createRepository,
    resetSoft,
    resetHard,
    snapshotPaths,
    discard,
    restoreDiscard,
    fileDiff,
    readBlob,
    isWorkingTreeBlob,
    // --format= drops the commit header, so the patch parses as is. A
    // merge's is against its first parent, what it brought in, as a
    // plain patch rather than git's combined one. Empty for a commit git
    // can't show one for. Paths come out as they are (core.quotePath),
    // not octal-escaped, here and in mergeBaseDiff and readStashDiff,
    // since the file list shows them and opens them, and blob ids in
    // full (--full-index), since a binary file's sides are read back by
    // them (readBlob).
    commitDiff: Effect.fn("Git.commitDiff")(function* (worktree, hash) {
      return yield* run(
        worktree,
        [
          "-c",
          "core.quotePath=false",
          ...PATCH_CONFIG,
          "show",
          "--format=",
          "--no-color",
          "--full-index",
          ...PATCH_FLAGS,
          "--diff-merges=first-parent",
          "--end-of-options",
          hash,
          "--",
        ],
        { maxOutputBytes: PATCH_MAX_OUTPUT, anyExit: true },
      ).pipe(Effect.catchTags({ GitCommandError: () => Effect.succeed("") }));
    }),
    // Both have to be commits the repository already holds.
    mergeBaseDiff: Effect.fn("Git.mergeBaseDiff")(function* (input) {
      return yield* run(
        input.repo,
        [
          "-c",
          "core.quotePath=false",
          ...PATCH_CONFIG,
          "diff",
          "--no-color",
          "--full-index",
          ...PATCH_FLAGS,
          "--end-of-options",
          `${input.base}...${input.head}`,
        ],
        { maxOutputBytes: PATCH_MAX_OUTPUT },
      );
    }),
  });
});

export const layer = Layer.effect(Git, make);
