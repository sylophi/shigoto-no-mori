// Git's errors, documents and the pure helpers its areas share (EFFECT.md, section 2). `Git.ts` re-exports what consumers use.
import type { CommitPicks } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { errorMessageOf } from "@shigomori/contracts/errors";

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
// has. The contract's, so the app's caller offers the forced delete.
export { BranchNotMergedError } from "@shigomori/contracts/errors";

// A name that resolves to no commit here.
export class UnknownRevisionError extends Schema.TaggedError<UnknownRevisionError>()(
  "UnknownRevisionError",
  { ref: Schema.String },
) {
  override get message(): string {
    return `There is no branch or commit named ${this.ref}.`;
  }
}

// A move git would make that the app refuses, in words for the person
// who asked: an operation under way, conflicts left, nothing to do.
export class GitRefusedError extends Schema.TaggedError<GitRefusedError>()(
  "GitRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// HEAD moved on from where a caller pinned it: what a move made from a
// loaded page asks, so it can't land on a branch that changed since.
export class BranchMovedError extends Schema.TaggedError<BranchMovedError>()(
  "BranchMovedError",
  {},
) {
  override get message(): string {
    return "The branch has moved on since this was loaded. Reload and try again.";
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

// Why an undo (or its redo) would not move HEAD: the target is off
// HEAD's line, or a merge is between.
export class UndoRefusedError extends Schema.TaggedError<UndoRefusedError>()(
  "UndoRefusedError",
  { reason: Schema.Literals(["off-history", "across-merge"]) },
) {
  override get message(): string {
    switch (this.reason) {
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
  errorMessageOf(error.cause);

export const SHOWN = 3;
export const listed = (paths: readonly string[], count: number): string =>
  `${paths.join(", ")}${count > paths.length ? ` (+${count - paths.length} more)` : ""}`;

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
  // Any exit still answers with what git printed before it: a patch
  // read keeps the files git got through when a later one fails (an
  // external diff driver, a textconv). Output past the cap and a git
  // that never ran still fail.
  readonly anyExit?: boolean | undefined;
  // A fetch from a file on this machine (a bundle), which no network can
  // stall, so it has no deadline however long its index takes.
  readonly local?: boolean | undefined;
  // The output cap, over DEFAULT_MAX_OUTPUT. Only the patch reads
  // raise it.
  readonly maxOutputBytes?: number | undefined;
};

// A commit from the changes page: the picks, and the message. Two `-m`
// flags give git the summary and body as separate paragraphs. `amend`
// folds the picks into HEAD under the new message instead of adding a
// commit, with no summary keeps HEAD's message, and with nothing picked
// rewrites only the message.
export type CommitRequest = CommitPicks & {
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly amend?: boolean | undefined;
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

export const DISCARD_REF_PREFIX = "refs/shigomori/discards/";

// --- limits -------------------------------------------------------------

// The worktree list fans out over every project, worktree and probe.
// Unbounded, that is hundreds of processes and the time goes into
// fork and exec.
export const SPAWN_SLOTS = Math.max(
  4,
  globalThis.navigator?.hardwareConcurrency ?? 4,
);

// What takes a slot: the read-only probes a row fans out over, which
// run none of the user's hooks. Anything else goes outside the slots,
// since it can hold one for minutes while the probes queue behind it:
// a wait on a remote, or the hooks a write runs (a commit's, a
// checkout's, and any ref update's reference-transaction). A status
// still runs a configured fsmonitor and a diff an external driver,
// under a slot as before: the probes the cap is for.
export const SLOTTED_SUBCOMMANDS = new Set([
  "status",
  "rev-parse",
  "rev-list",
  "log",
  "show",
  "diff",
  "ls-files",
  "ls-tree",
  "cat-file",
  "for-each-ref",
  "show-ref",
  "merge-base",
  "merge-tree",
  "write-tree",
  "hash-object",
  "check-ignore",
  "config",
  "remote",
  // `worktree add` runs the post-checkout hook, its list nothing.
  "worktree list",
]);

// Covers any status, log or ref output by a wide margin.
export const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;

// A patch is the one output whose size the user decides: one
// regenerated lockfile runs to tens of megabytes on its own.
export const PATCH_MAX_OUTPUT = 64 * 1024 * 1024;

// Every patch a diff page parses is git's own, whatever the user's
// config. The a/ and b/ prefixes, which diff.noprefix and its kin would
// change, are pinned as config before the command: `stash show` drops
// --src-prefix under diff.noprefix, and --default-prefix is newer than
// the git floor (2.40), which leaves a key it doesn't know alone.
export const PATCH_CONFIG = [
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
] as const;

// And after it, no external diff or textconv in place of a change.
export const PATCH_FLAGS = ["--no-ext-diff", "--no-textconv"] as const;

// Pathspecs travel as argv, and a big refactor can carry enough paths
// to brush the OS's limit, so they go one chunk per git.
export const PATHSPEC_CHUNK = 500;

// Past this many changed paths the newest change is almost certainly
// seen, and a huge dirty tree shouldn't cost a stat per file.
export const CHANGE_MTIME_STATS = 64;

export const UNPUSHED_LIMIT = 1000;

// How far behind the primary a branch can be and still be asked
// whether it landed. Past it the answer stopped mattering, and "not
// landed" leaves the row where it was.
export const FIRST_PARENT_LIMIT = 2000;

export const LOCAL_TIPS_LIMIT = 256;

// A ref that must not exist yet, in update-ref's compare-and-set.
export const ZERO_SHA = "0".repeat(40);

export const DISCARD_SNAPSHOTS_KEPT = 40;

// Untracked files are counted from disk with git's own limits: a NUL in
// the first 8k means binary, and past a few MB a count is not worth
// reading the file for.
export const BINARY_SNIFF_BYTES = 8000;
export const UNTRACKED_COUNT_LIMIT = 4 * 1024 * 1024;

export const encoder = new TextEncoder();
// A byte order mark git prints first is the content's own (a blob that
// starts with one), so it stays.
export const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// git names the URL it wanted a password for, userinfo and all, and a
// pasted token sits there.
export const redactUserinfo = (text: string): string =>
  text.replace(/(https?:\/\/)[^/\s'"]*@/gi, "$1");

export const identity = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;
