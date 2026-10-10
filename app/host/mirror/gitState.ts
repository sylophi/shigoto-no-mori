// The git half of a mirrored worktree (PRODUCT.md: "both sides are
// real git worktrees whose branch, commits, and uncommitted changes
// agree"). The file-sync engine keeps the working tree identical. This
// module makes the rest of what `git status` shows agree too. A
// worktree's git state, for mirroring purposes, is three facts:
//
//   - HEAD: the branch it is on (or detached),
//   - the tip: the commit HEAD resolves to,
//   - the index: WHAT is staged, as the tree the index would commit.
//
// The index is captured as a tree rather than as the index file, since
// the file is full of machine-specific stat data and lock semantics.
// When that tree differs from HEAD's (something is staged), it is
// wrapped in a throwaway commit on refs/shigomori/index/<worktreeId>
// so the existing bundle transfer can carry it. When nothing is
// staged, the ref is removed and the tree is HEAD's own.
//
// Reads are made cheap because the follower reads on every signal and
// on a sweep: one rev-parse answers HEAD, the tip, the tip's tree and
// the git dir together. The index tree is recomputed only when the
// index file's identity (size, mtime, ctime, inode) moved, from a
// scratch copy so write-tree never touches the real index (it would
// echo through every index watcher, this module's included).
//
// A worktree in the middle of a git operation (a rebase, a merge, a
// cherry-pick, a revert, a bisect) has no state worth mirroring: HEAD
// is detached or the index holds conflicts for a moment the user is
// still working through, and carrying that to the other side would
// leave it somewhere the finished operation never goes. Both the read
// and the apply refuse while one is under way, in words the follower
// recognizes (GIT_OPERATION_IN_PROGRESS).
//
// Applying a state is deliberately narrow and guarded: refs move by
// compare-and-set against the state the caller last saw, branch
// collisions refuse with the path that holds the branch, and the
// working tree is never touched (the engine owns it). read-tree plus
// an index refresh is what makes the staged view match without
// rewriting a single file.
import { copyFile, mkdtemp, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@shigomori/contracts/schemas";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Deferred from "effect/Deferred";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type GitError, run, runLenient } from "@host/lib/git/core";
import { gitDirOf, operationInProgress } from "@host/lib/git/operation";
import {
  deleteRef,
  hasCommit,
  hasObject,
  isAncestor,
  refTip,
  treeOf,
  updateRef,
  ZERO_SHA,
} from "@host/lib/git/refs";
import { listCheckouts, worktreeIdFromPath } from "@host/lib/git/worktrees";

// A state that can't be read or applied, in the words the other device
// hears (an operation in progress among them, operationInRefusal).
class GitStateError extends Schema.TaggedError<GitStateError>()(
  "GitStateError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export type GitHead = { kind: "branch"; branch: string } | { kind: "detached" };

export type GitState = {
  head: GitHead;
  tip: string;
  indexTree: string;
  // The commit carrying indexTree for transfer, or null when the index
  // equals HEAD's tree and there is nothing to carry.
  indexCommit: string | null;
};

// The part of a state that changes hands: head, tip and the staged
// tree. The carrier commit is transport detail.
export type GitStateCore = Pick<GitState, "head" | "tip" | "indexTree">;

export function indexRefFor(worktreeId: string): string {
  return `refs/shigomori/index/${worktreeId}`;
}

// Pinned identity for the carrier commits, so they never depend on
// the machine's git config.
const CAPTURE_IDENT: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "shigomori",
  GIT_AUTHOR_EMAIL: "shigomori@localhost",
  GIT_COMMITTER_NAME: "shigomori",
  GIT_COMMITTER_EMAIL: "shigomori@localhost",
};

// The leading words of every refusal over an operation in progress,
// followed by ": " and the operation's name. Text rather than a code
// because the read's refusal reaches the other device as an error, and
// an error crosses the wire flattened to its message.
const GIT_OPERATION_IN_PROGRESS = "A git operation is in progress";

function operationRefusal(operation: string): string {
  return `${GIT_OPERATION_IN_PROGRESS}: ${operation}`;
}

// The operation a refusal names, or null when the text is some other
// failure. Matches anywhere in the text, since a relayed error may
// carry a prefix of its own.
export function operationInRefusal(text: string): string | null {
  const at = text.indexOf(`${GIT_OPERATION_IN_PROGRESS}: `);
  if (at === -1) return null;
  const rest = text.slice(at + GIT_OPERATION_IN_PROGRESS.length + 2);
  return rest.split("\n")[0]?.trim() || "git operation";
}

// HEAD, the tip, the tip's tree and the git dir in one spawn, and the
// operation under way if any. An unborn HEAD fails the rev-parse, which
// is the one state this module refuses outright.
type HeadFacts = {
  head: GitHead;
  tip: string;
  headTree: string;
  gitDir: string;
  operation: string | null;
};

const readHeadFacts = Effect.fnUntraced(function* (worktreePath: string) {
  const out = yield* run(worktreePath, [
    "rev-parse",
    "HEAD",
    "HEAD^{tree}",
    "--symbolic-full-name",
    "HEAD",
    "--absolute-git-dir",
  ]).pipe(
    Effect.mapError(
      (error) =>
        new GitStateError({
          reason: `the worktree has no commits yet (${errorMessageOf(error)})`,
        }),
    ),
  );
  const [tip = "", headTree = "", ref = "", gitDir = ""] = out
    .split("\n")
    .map((line) => line.trim());
  if (tip === "" || headTree === "" || gitDir === "") {
    return yield* new GitStateError({
      reason: "the worktree has no commits yet",
    });
  }
  const head: GitHead = ref.startsWith("refs/heads/")
    ? { kind: "branch", branch: ref.slice("refs/heads/".length) }
    : { kind: "detached" };
  return {
    head,
    tip,
    headTree,
    gitDir,
    operation: yield* Effect.promise(() => operationInProgress(gitDir)),
  } satisfies HeadFacts;
});

// The last index tree computed per worktree, keyed on the index file's
// identity: the steady state of a mirrored worktree is "unchanged since
// last look", and that costs one stat. Size and mtime alone can miss a
// rewrite within the filesystem's timestamp granularity that happens
// to keep the size (a stage swapped for another of the same length).
// git writes the index by renaming a fresh file over it, so the inode
// changes on every write, and ctime catches an in-place touch.
type IndexIdentity = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
};
type IndexSnapshot = IndexIdentity & { tree: string };

function sameIdentity(a: IndexIdentity, b: IndexIdentity): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino
  );
}
const indexSnapshots = new Map<string, IndexSnapshot>();

// One private 0700 directory for every scratch index, minted lazily and
// kept for the life of the process. Directly under a shared /tmp the
// copies' names are guessable, so another account could read one or
// pre-plant it as a symlink for the copyFile below to write through.
let scratchDir: Promise<string> | null = null;

function scratchIndexDir(): Promise<string> {
  // A failed mint is not cached, or one transient temp-dir error would
  // poison every recompute for the rest of the run.
  scratchDir ??= mkdtemp(join(tmpdir(), "sm-index-")).catch(
    (error: unknown) => {
      scratchDir = null;
      throw error;
    },
  );
  return scratchDir;
}

// A stable scratch index per worktree inside that directory, overwritten
// on every recompute, so no directory is minted and removed per read.
// One computation at a time per worktree (below), since two copies
// racing on the same scratch file would hand write-tree a torn index.
async function scratchIndexPath(worktreePath: string): Promise<string> {
  return join(await scratchIndexDir(), worktreeIdFromPath(worktreePath));
}

// Copies the index into the scratch dir, re-minting it once if it went
// away: the OS reaps its temp dir on its own schedule, and a
// long-running app can outlive the path it cached.
async function copyIndexToScratch(
  worktreePath: string,
  indexPath: string,
): Promise<string> {
  const copy = await scratchIndexPath(worktreePath);
  try {
    await copyFile(indexPath, copy);
    return copy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Either the source index vanished (nothing to retry) or our
    // scratch dir did. Re-mint and let a second ENOENT stand.
    scratchDir = null;
    const fresh = await scratchIndexPath(worktreePath);
    await copyFile(indexPath, fresh);
    return fresh;
  }
}

const indexTreeInFlight = new Map<
  string,
  Deferred.Deferred<string, GitStateError>
>();

// The tree the index would commit right now. Concurrent readers of one
// worktree (the follower and a peer's gitState call) share one run.
const indexTreeOf = (worktreePath: string, gitDir: string, headTree: string) =>
  Effect.suspend(() => {
    const running = indexTreeInFlight.get(worktreePath);
    if (running !== undefined) return Deferred.await(running);
    const computing = Deferred.makeUnsafe<string, GitStateError>();
    indexTreeInFlight.set(worktreePath, computing);
    return computeIndexTree(worktreePath, gitDir, headTree).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          indexTreeInFlight.delete(worktreePath);
          Deferred.doneUnsafe(computing, exit);
        }),
      ),
    );
  });

const computeIndexTree = Effect.fnUntraced(function* (
  worktreePath: string,
  gitDir: string,
  headTree: string,
) {
  const indexPath = join(gitDir, "index");
  const identity = yield* Effect.promise(() =>
    stat(indexPath).then(
      (info): IndexIdentity => ({
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
      }),
      () => null,
    ),
  );
  if (identity === null) {
    // No index yet (a worktree git has not touched since creation):
    // the index would commit HEAD's tree.
    indexSnapshots.delete(worktreePath);
    return headTree;
  }
  const cached = indexSnapshots.get(worktreePath);
  if (cached !== undefined && sameIdentity(cached, identity)) {
    return cached.tree;
  }
  const unsnapshotted = (error: unknown) =>
    new GitStateError({
      reason: `the index cannot be snapshotted (unresolved conflicts?): ${errorMessageOf(error)}`,
    });
  const copy = yield* Effect.tryPromise({
    try: () => copyIndexToScratch(worktreePath, indexPath),
    catch: unsnapshotted,
  });
  const tree = (yield* run(worktreePath, ["write-tree"], {
    env: { GIT_INDEX_FILE: copy },
  }).pipe(Effect.mapError(unsnapshotted))).trim();
  indexSnapshots.set(worktreePath, { ...identity, tree });
  return tree;
});

// The three facts, read-only: nothing is written. HEAD's tree rides
// along for readGitState, which compares the index tree against it.
// An operation in progress answers with its name alone: its index may
// hold conflicts write-tree cannot snapshot, and neither caller wants
// the facts of a state it is about to refuse.
type Peek =
  | { operation: string }
  | (GitStateCore & { headTree: string; operation: null });

const peekGitState = Effect.fnUntraced(function* (worktreePath: string) {
  const facts = yield* readHeadFacts(worktreePath);
  if (facts.operation !== null) return { operation: facts.operation } as Peek;
  const indexTree = yield* indexTreeOf(
    worktreePath,
    facts.gitDir,
    facts.headTree,
  );
  return {
    head: facts.head,
    tip: facts.tip,
    indexTree,
    headTree: facts.headTree,
    operation: null,
  } as Peek;
});

// Worktrees this process knows to carry NO index ref, so the clean
// path deletes the ref only when one may exist: the first read per
// worktree (a previous run may have left one) and every clean read
// after a mint. A mint takes the worktree back out of the set.
const carrierClean = new Set<string>();

// The full state, with the carrier commit for a staged index minted
// (or an obsolete one removed) so the transfer can name it. Throws
// operationRefusal(...) while an operation is in progress, so the
// follower reading here and the peer this read is served to both hear
// the same words.
export const readGitState = Effect.fnUntraced(function* (
  projectPath: string,
  worktreePath: string,
  worktreeId: string,
) {
  const peek = yield* peekGitState(worktreePath);
  if (peek.operation !== null) {
    return yield* new GitStateError({
      reason: operationRefusal(peek.operation),
    });
  }
  const { headTree } = peek;
  const core = { head: peek.head, tip: peek.tip, indexTree: peek.indexTree };
  const ref = indexRefFor(worktreeId);
  if (core.indexTree === headTree) {
    if (!carrierClean.has(worktreeId)) {
      yield* Effect.ignore(deleteRef(projectPath, ref));
      carrierClean.add(worktreeId);
    }
    return { ...core, indexCommit: null } satisfies GitState;
  }
  carrierClean.delete(worktreeId);
  const existing = yield* refTip(projectPath, ref);
  if (
    existing !== null &&
    (yield* treeOf(projectPath, existing)) === core.indexTree
  ) {
    return { ...core, indexCommit: existing } satisfies GitState;
  }
  const commit = (yield* run(
    projectPath,
    [
      "commit-tree",
      core.indexTree,
      "-p",
      core.tip,
      "-m",
      "shigomori index snapshot",
    ],
    { env: CAPTURE_IDENT },
  )).trim();
  yield* updateRef(projectPath, ref, commit);
  return { ...core, indexCommit: commit } satisfies GitState;
});

export type ApplyGitStateInput = {
  // The state the caller last observed here. Anything else means the
  // worktree moved under the caller, and the apply refuses so the
  // caller can look again.
  expect: Pick<GitStateCore, "tip" | "indexTree">;
  state: GitStateCore;
  // App-owned refs to drop once the state landed (a landed incoming
  // branch, a consumed index carrier). Best effort.
  sweep?: readonly string[];
};

type ApplyGitStateResult =
  | { applied: true }
  | { applied: false; reason: string };

// Moves this worktree's git state to `state`. Returns a refusal rather
// than throwing for every case that is a fact about the repository
// (someone changed it, a branch collision, missing objects), so the
// follower can show the reason and wait. Throws only on git failing
// to do what it was asked.
// The landing refs the caller names in `sweep` are carriers the fetch
// or push created for this apply. They go whatever the outcome, so a
// refused apply cannot leave one behind to block a later branch nested
// under its name (refs/shigomori/incoming/feat blocks .../feat/x).
export const applyGitState = (
  project: Project,
  worktree: { id: string; path: string },
  input: ApplyGitStateInput,
) =>
  applyGitStateUnswept(project, worktree, input).pipe(
    Effect.ensuring(
      Effect.forEach(
        (input.sweep ?? []).filter((ref) => ref.startsWith("refs/shigomori/")),
        (ref) => Effect.ignore(deleteRef(project.path, ref)),
        { concurrency: "unbounded", discard: true },
      ),
    ),
  );

const refused = (reason: string): ApplyGitStateResult => ({
  applied: false,
  reason,
});

const applyGitStateUnswept = Effect.fnUntraced(function* (
  project: Project,
  worktree: { id: string; path: string },
  input: ApplyGitStateInput,
) {
  const current = yield* peekGitState(worktree.path);
  if (current.operation !== null) {
    return refused(operationRefusal(current.operation));
  }
  if (
    current.tip !== input.expect.tip ||
    current.indexTree !== input.expect.indexTree
  ) {
    return refused("changed-locally");
  }
  const { state } = input;
  const [tipHere, indexTreeHere] = yield* Effect.all(
    [
      hasCommit(project.path, state.tip),
      hasObject(project.path, `${state.indexTree}^{tree}`),
    ],
    { concurrency: 2 },
  );
  if (!tipHere || !indexTreeHere) return refused("missing-objects");

  if (state.head.kind === "branch") {
    const target = state.head.branch;
    const targetRef = `refs/heads/${target}`;
    const currentBranch =
      current.head.kind === "branch" ? current.head.branch : null;
    if (target === currentBranch) {
      if (current.tip !== state.tip) {
        yield* updateRef(project.path, targetRef, state.tip, current.tip);
      }
    } else {
      // A branch switch. The branch may exist here already: refuse if
      // another worktree holds it (git would too, less clearly) or if
      // it carries commits the incoming tip does not (moving it would
      // orphan them). Otherwise create it or fast-forward it, then
      // point HEAD at it.
      const checkouts = yield* listCheckouts(project.path);
      const elsewhere = checkouts.find(
        (w) => w.branch === target && w.path !== worktree.path,
      );
      if (elsewhere !== undefined) {
        return refused(
          `branch ${target} is checked out at ${elsewhere.path} on this device`,
        );
      }
      const existingTip = yield* refTip(project.path, targetRef);
      if (
        existingTip !== null &&
        existingTip !== state.tip &&
        !(yield* isAncestor(project.path, existingTip, state.tip))
      ) {
        return refused(
          `branch ${target} on this device has commits the other device does not`,
        );
      }
      if (existingTip !== state.tip) {
        yield* updateRef(
          project.path,
          targetRef,
          state.tip,
          existingTip ?? ZERO_SHA,
        );
      }
      yield* run(worktree.path, ["symbolic-ref", "HEAD", targetRef]);
    }
  } else if (current.head.kind !== "detached" || current.tip !== state.tip) {
    yield* run(worktree.path, [
      "update-ref",
      "--no-deref",
      "--end-of-options",
      "HEAD",
      state.tip,
    ]);
  }

  // The staged view: the index becomes the incoming tree, then a
  // refresh re-stats every entry against the (already mirrored) files
  // so unchanged ones do not read as modified. refresh exits non-zero
  // when files differ from the index, which is the ordinary dirty case.
  yield* readTreeRetrying(worktree.path, state.indexTree);
  yield* runLenient(worktree.path, ["update-index", "-q", "--refresh"]);
  return { applied: true } as ApplyGitStateResult;
});

// The pauses between read-tree attempts while another git process
// holds the index lock. Any `git status` takes the lock for a moment
// to refresh, so a busy worktree (an editor's git integration, a
// prompt) holds it often but briefly. By the time read-tree runs the
// ref has moved already, so giving up here leaves the state half
// applied: the follower heals that on its next look (it compares the
// index alone when both sides already share a tip), but a short wait
// usually saves the round.
const INDEX_LOCK_BACKOFF_MS = [50, 100, 200, 400, 800];

const readTreeRetrying = (worktreePath: string, tree: string) => {
  const attempt = (
    n: number,
  ): Effect.Effect<void, GitError, ChildProcessSpawner.ChildProcessSpawner> =>
    run(worktreePath, ["read-tree", tree]).pipe(
      Effect.asVoid,
      Effect.catchIf(
        (error) =>
          INDEX_LOCK_BACKOFF_MS[n] !== undefined &&
          error.reason.includes("index.lock"),
        () =>
          Effect.andThen(
            Effect.sleep(INDEX_LOCK_BACKOFF_MS[n] ?? 0),
            attempt(n + 1),
          ),
      ),
    );
  return attempt(0);
};

// Fires when the worktree's index file is rewritten (a stage, an
// unstage, a checkout, also git's own refreshes: the consumer compares
// trees to tell them apart). Returns the stop function. Resolves the
// git dir once. A worktree whose git dir moves is a removed worktree.
export const watchIndexFile = (
  worktreePath: string,
  onChange: () => void,
  debounceMs = 300,
) =>
  Effect.map(gitDirOf(worktreePath), (gitDir) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: ReturnType<typeof watch>;
    try {
      watcher = watch(gitDir, { persistent: false });
    } catch {
      return () => {};
    }
    watcher.on("change", (_event, file) => {
      if (file !== "index") return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, debounceMs);
    });
    watcher.on("error", () => {});
    return () => {
      if (timer !== null) clearTimeout(timer);
      watcher.close();
    };
  });
