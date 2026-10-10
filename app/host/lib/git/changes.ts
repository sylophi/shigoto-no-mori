// The working tree as the changes page sees it: a list of files to
// tick, commit or throw away. Everything here acts on whole files.
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  ChangeCounts,
  ChangedFile,
  ChangeKind,
  CommitMessage,
  StagedState,
} from "@shigomori/contracts/schemas";
import { isUntracked } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  chunked,
  GitRefusal,
  run,
  runLenient,
  splitZ,
  type RunOptions,
} from "./core";
import { refuseMidOperation } from "./operation";
import { verifyRev } from "./refs";
import { log } from "@shared/log";

// Discard snapshots kept per repository. Pruned by count rather than
// age, so a repo you touch monthly keeps as useful a tail as one you
// discard in daily.
const DISCARD_SNAPSHOTS_KEPT = 40;
const DISCARD_REF_PREFIX = "refs/shigomori/discards/";

// One git process per chunk of paths, run in order because index writes
// take index.lock. `--literal-pathspecs` because every path here came
// out of `git status` and is a filename, not a pattern: without it a
// file called `a[1].txt` is a glob.
export const runChunked = (
  worktreePath: string,
  args: string[],
  paths: readonly string[],
  options?: RunOptions,
) =>
  // Index writes take index.lock, so chunks run one after another.
  Effect.forEach(chunked(paths), (chunk) =>
    run(
      worktreePath,
      ["--literal-pathspecs", ...args, "--", ...chunk],
      options,
    ),
  );

// --- status ------------------------------------------------------------

// Porcelain v2 puts a fixed number of space-separated fields before the
// path. With -z the path itself is raw, spaces included, so it is
// whatever follows the Nth space.
function afterNthSpace(record: string, n: number): string {
  let index = -1;
  for (let i = 0; i < n; i++) {
    index = record.indexOf(" ", index + 1);
    if (index < 0) return "";
  }
  return record.slice(index + 1);
}

function stagedOf(x: string, y: string): StagedState {
  if (x === ".") return "none";
  return y === "." ? "all" : "partial";
}

// x is index vs HEAD and y is worktree vs index, and they can differ
// ("AM": added to the index, edited since). Whichever side says the
// file arrived or left wins. The other side is an edit on top of that.
function kindOf(x: string, y: string): ChangeKind {
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

// --- index queue -------------------------------------------------------

// Writes to one worktree's index run one after another. Git takes
// index.lock for each, so two quick discards, or a discard racing a
// commit, would otherwise fail on the lock instead of waiting. A failed task
// doesn't block the queue.
const indexLocks = new Map<string, Semaphore.Semaphore>();

export const onIndex = <A, E, R>(
  worktreePath: string,
  task: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const lock = indexLocks.get(worktreePath) ?? Semaphore.makeUnsafe(1);
    indexLocks.set(worktreePath, lock);
    return task.pipe(lock.withPermits(1));
  });

// --- line counts -------------------------------------------------------

// `--numstat -z` records are "<adds>\t<dels>\t<path>", except a rename
// leaves the path slot empty and spends two more fields on the old and
// new names. Binary files report "-" for both and map to undefined, so
// a caller can tell "git says no counts" from "git never mentioned it".
function parseNumstat(stdout: string): Map<string, ChangeCounts | undefined> {
  const fields = splitZ(stdout);
  const counts = new Map<string, ChangeCounts | undefined>();
  for (let i = 0; i < fields.length; i++) {
    const [adds = "", dels = "", path = ""] = (fields[i] ?? "").split("\t");
    const name = path === "" ? (fields[i + 2] ?? "") : path;
    if (path === "") i += 2;
    if (name === "") continue;
    const additions = Number.parseInt(adds, 10);
    const deletions = Number.parseInt(dels, 10);
    counts.set(
      name,
      Number.isFinite(additions) && Number.isFinite(deletions)
        ? { additions, deletions }
        : undefined,
    );
  }
  return counts;
}

// Untracked files are in no diff git can be asked for in one go, and a
// `--no-index` process per new file on every read is too much. Every
// line in a new file is an addition, so count newlines here, with git's
// own limits: a NUL in the first 8k means binary, and past a few MB it
// is not worth reading a file to put a number beside its name.
const BINARY_SNIFF_BYTES = 8000;
const UNTRACKED_COUNT_LIMIT = 4 * 1024 * 1024;

async function countUntracked(
  worktreePath: string,
  path: string,
): Promise<ChangeCounts | undefined> {
  const full = join(worktreePath, path);
  try {
    // lstat, not stat: a symlink is a one-line blob to git, and
    // following it would count whatever it points at instead.
    const stats = await lstat(full);
    if (!stats.isFile() || stats.size > UNTRACKED_COUNT_LIMIT) return undefined;
    const contents = await readFile(full);
    if (contents.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
    let additions = 0;
    // `indexOf` is a native scan. A `for..of` over the bytes would run
    // the iterator protocol millions of times on the main process.
    for (
      let at = contents.indexOf(0x0a);
      at !== -1;
      at = contents.indexOf(0x0a, at + 1)
    ) {
      additions++;
    }
    // A last line without its newline is still a line.
    if (contents.length > 0 && contents.at(-1) !== 0x0a) additions++;
    return { additions, deletions: 0 };
  } catch {
    // Vanished since the status walk, or unreadable. The row still
    // lists, just without counts.
    return undefined;
  }
}

// The +/- each row shows. One `diff HEAD --numstat` covers everything
// git knows about: tracked edits, staged or not, and deletions. New
// files are counted from disk, one at a time so a worktree with an
// unignored build directory holds one file's bytes in memory rather
// than all of them. The two reads don't depend on each other.
const countsFor = Effect.fnUntraced(function* (
  worktreePath: string,
  files: readonly ChangedFile[],
) {
  const readUntracked = Effect.promise(async () => {
    const counted = new Map<string, ChangeCounts | undefined>();
    for (const file of files.filter(isUntracked)) {
      // oxlint-disable-next-line no-await-in-loop -- one file's bytes in memory at a time, not every file's
      counted.set(file.path, await countUntracked(worktreePath, file.path));
    }
    return counted;
  });
  const [tracked, untracked] = yield* Effect.all(
    [
      Effect.map(
        runLenient(worktreePath, [
          "-c",
          "core.quotePath=false",
          "diff",
          "HEAD",
          "--numstat",
          "-z",
        ]),
        parseNumstat,
      ),
      readUntracked,
    ],
    { concurrency: 2 },
  );
  return files.map((file) => {
    // Look up by what the row is, not just its path: `git rm --cached f`
    // leaves a staged deletion and an untracked file both called f, and
    // the numstat only speaks for the first.
    const counts = isUntracked(file)
      ? untracked.get(file.path)
      : tracked.get(file.path);
    return counts ? { ...file, counts } : file;
  });
});

// `git status --porcelain=v2 -z`, one file per entry. This is the one
// status parser. The sidebar's per-worktree count runs it too.
//
// `untracked: "all"` lists every file of an untracked directory as its
// own row, which the changes page needs so it can diff and discard each
// one. The sidebar scan leaves it unset so a user's
// `status.showUntrackedFiles = no` keeps that scan cheap (see
// getWorkingTreeChanges). `counts` is a second pass over the tree and
// is off by default for the same reason.
export const listChangedFiles = Effect.fnUntraced(function* (
  worktreePath: string,
  options: { untracked?: "all"; counts?: boolean } = {},
) {
  const args = ["status", "--porcelain=v2", "-z"];
  if (options.untracked) args.push(`--untracked-files=${options.untracked}`);
  const stdout = yield* run(worktreePath, args);
  const fields = splitZ(stdout);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] ?? "";
    const type = record[0];
    if (type === "?") {
      files.push({ path: record.slice(2), kind: "added", staged: "none" });
    } else if (type === "1") {
      files.push({
        path: afterNthSpace(record, 8),
        kind: kindOf(record[2] ?? ".", record[3] ?? "."),
        staged: stagedOf(record[2] ?? ".", record[3] ?? "."),
      });
    } else if (type === "2") {
      // Rename/copy: the original path follows as its own NUL field.
      const staged = stagedOf(record[2] ?? ".", record[3] ?? ".");
      const prevPath = fields[++i];
      files.push({
        path: afterNthSpace(record, 9),
        kind: "renamed",
        prevPath,
        staged,
      });
    } else if (type === "u") {
      files.push({
        path: afterNthSpace(record, 10),
        // Both sides of an unmerged path have content. What it needs is
        // resolving, and `conflicted` is what the page reads for that.
        kind: "modified",
        staged: "none",
        conflicted: true,
      });
    }
    // "!" (ignored) only appears with --ignored, and "#" headers only
    // with --branch. Anything else is skipped rather than guessed at.
  }
  // Git emits status in its own order. Sort by path once here so the
  // rail, the commit and the page's first pick all agree.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return options.counts ? yield* countsFor(worktreePath, files) : files;
});

// What the changes page reads: every file as its own row, with counts.
export const listChangesForPage = (worktreePath: string) =>
  listChangedFiles(worktreePath, { untracked: "all", counts: true });

// --- commit ------------------------------------------------------------

// A commit's message split the way the composer holds it. `%s` and `%b`
// are git's own split, and a NUL between them survives any subject a
// human could type.
export const readCommitMessage = (worktreePath: string, hash: string) =>
  Effect.map(
    run(worktreePath, [
      "show",
      "-s",
      "--format=%s%x00%b",
      "--end-of-options",
      hash,
      "--",
    ]),
    (stdout): CommitMessage => {
      const cut = stdout.indexOf("\0");
      if (cut < 0) return { summary: stdout.trim(), description: "" };
      return {
        summary: stdout.slice(0, cut).trim(),
        description: stdout.slice(cut + 1).trim(),
      };
    },
  );

// --- undo --------------------------------------------------------------

const isAncestor = (
  worktreePath: string,
  ancestor: string,
  descendant: string,
) =>
  run(worktreePath, [
    "merge-base",
    "--is-ancestor",
    "--end-of-options",
    ancestor,
    descendant,
  ]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

// `git reset --soft`: HEAD moves and nothing else does, so the commits
// between come back as staged changes and no file content is touched.
// Only along HEAD's own line: backwards to an ancestor for an undo, or
// forwards to a descendant for the redo of that undo, which needs the
// caller to pin where HEAD must still be. Anything committed since
// makes it a different branch and the redo is refused. Refused across a
// merge too, since soft-resetting past one stages the whole other side
// as edits, which is nothing anyone means by "undo". A merge on top,
// undone to its first parent, comes off whole instead (`reset --keep`,
// which refuses rather than lose a local edit), and its redo puts it
// back.
//
// Returns where HEAD was, for the redo.
export const resetSoft = (
  worktreePath: string,
  target: string,
  expectHead: string | undefined,
) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      yield* refuseMidOperation(worktreePath);
      const [head, expected] = yield* Effect.all(
        [
          verifyRev(worktreePath, "HEAD"),
          expectHead
            ? verifyRev(worktreePath, expectHead)
            : Effect.succeed(undefined),
        ],
        { concurrency: 2 },
      );
      if (expected !== undefined && head !== expected) {
        return yield* new GitRefusal({
          reason:
            "The branch has moved on since this was loaded. Reload and try again.",
        });
      }
      const backwards = yield* isAncestor(worktreePath, target, head);
      const forwards =
        !backwards && expectHead !== undefined
          ? yield* isAncestor(worktreePath, head, target)
          : false;
      if (!backwards && !forwards) {
        return yield* new GitRefusal({
          reason: "That commit isn't on this branch's history.",
        });
      }
      const [older, newer] = backwards ? [target, head] : [head, target];
      // One merge, stepped over to its first parent and back: the merge
      // comes off (or goes back on) whole.
      const firstParent = yield* verifyRev(worktreePath, `${newer}^1`).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const wholeMerge =
        firstParent !== undefined &&
        (yield* verifyRev(worktreePath, older)) === firstParent &&
        (yield* verifyRev(worktreePath, `${newer}^2`).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ));
      if (wholeMerge) {
        yield* run(worktreePath, [
          "reset",
          "--keep",
          "--end-of-options",
          target,
        ]);
        return head;
      }
      const merges = (yield* run(worktreePath, [
        "rev-list",
        "--merges",
        "--count",
        "--end-of-options",
        `${older}..${newer}`,
      ])).trim();
      if (merges !== "0") {
        return yield* new GitRefusal({
          reason: "Can't undo across a merge commit.",
        });
      }
      yield* run(worktreePath, ["reset", "--soft", "--end-of-options", target]);
      return head;
    }),
  );

// --- discard -----------------------------------------------------------

// A commit of `paths` as they sit in the working tree right now, kept
// under refs/shigomori/discards/. Built in a scratch index so the real
// one is untouched: read HEAD's tree in, `add -A` the paths over it
// (that records edits, additions and deletions alike), write the tree
// and wrap it in a commit. The ref keeps the objects alive through gc
// and shows up in `git for-each-ref` for anyone recovering by hand.
// restoreDiscard is the app's own way back.
export const snapshotPaths = (worktreePath: string, paths: readonly string[]) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "shigomori-discard-"))),
    (scratch) =>
      Effect.gen(function* () {
        const env = {
          GIT_INDEX_FILE: join(scratch, "index"),
          // The snapshot commit's own identity, so a repo with no
          // user.name configured can still discard safely.
          GIT_AUTHOR_NAME: "Shigoto no Mori",
          GIT_AUTHOR_EMAIL: "shigomori@localhost",
          GIT_COMMITTER_NAME: "Shigoto no Mori",
          GIT_COMMITTER_EMAIL: "shigomori@localhost",
        };
        const head = (yield* runLenient(worktreePath, [
          "rev-parse",
          "--verify",
          "--quiet",
          "HEAD",
        ])).trim();
        // An unborn branch has no HEAD tree to start from, so the
        // snapshot becomes a root commit of just the discarded files.
        yield* run(
          worktreePath,
          head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"],
          { env },
        );
        yield* runChunked(worktreePath, ["add", "-A"], paths, { env });
        const tree = (yield* run(worktreePath, ["write-tree"], { env })).trim();
        const args = [
          "commit-tree",
          tree,
          "-m",
          `Discarded from ${basename(worktreePath)}: ${paths.length} file${paths.length === 1 ? "" : "s"}`,
        ];
        if (head) args.push("-p", head);
        const commit = (yield* run(worktreePath, args, { env })).trim();
        yield* run(worktreePath, [
          "update-ref",
          `${DISCARD_REF_PREFIX}${Date.now()}`,
          commit,
        ]);
        yield* pruneDiscardSnapshots(worktreePath);
        return commit;
      }),
    (scratch) =>
      Effect.promise(() => rm(scratch, { recursive: true, force: true })),
  );

// Ref names are millisecond timestamps of equal width, so a reverse
// name sort is newest first. Best effort: a failed prune only leaves an
// extra ref behind.
const pruneDiscardSnapshots = (worktreePath: string) =>
  Effect.gen(function* () {
    const stdout = yield* run(worktreePath, [
      "for-each-ref",
      "--format=%(refname)",
      "--sort=-refname",
      DISCARD_REF_PREFIX,
    ]);
    const refs = stdout.split("\n").filter(Boolean);
    yield* Effect.forEach(
      refs.slice(DISCARD_SNAPSHOTS_KEPT),
      (ref) => run(worktreePath, ["update-ref", "-d", ref]),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.catch((err) =>
      Effect.sync(() =>
        log.warn("[changes] discard snapshot prune failed:", err),
      ),
    ),
  );

// Throw away the working-tree changes to `paths`, snapshotting them
// first so the toast can offer an undo. If the snapshot fails the
// discard is off, since it would be the only copy of the work.
//
// Then: unstage (a staged addition becomes untracked, a staged deletion
// comes back to the index), restore whatever the index now knows from
// it, and clean the rest, which by then is exactly the untracked set.
// Two lists because `restore` refuses paths git doesn't know and
// `clean` ignores paths it does.
export const discardChanges = (
  worktreePath: string,
  paths: readonly string[],
) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      const snapshot = yield* snapshotPaths(worktreePath, paths);
      yield* runChunked(worktreePath, ["reset", "-q"], paths);
      const tracked = new Set(
        (yield* runChunked(worktreePath, ["ls-files", "-z"], paths)).flatMap(
          splitZ,
        ),
      );
      const untracked = paths.filter((p) => !tracked.has(p));
      if (tracked.size > 0) {
        yield* runChunked(
          worktreePath,
          ["restore", "--worktree"],
          [...tracked],
        );
      }
      if (untracked.length > 0) {
        // -d: an untracked path can be the last file in a fresh directory.
        yield* runChunked(worktreePath, ["clean", "-fdq"], untracked);
        // `clean` walks past a nested repository without a word, and the
        // snapshot holds only its gitlink, so "discarded" would be a lie
        // there. Say what stayed instead.
        const left = (yield* runChunked(
          worktreePath,
          ["ls-files", "-z", "--others", "--exclude-standard"],
          untracked,
        )).flatMap(splitZ);
        if (left.length > 0) {
          return yield* new GitRefusal({
            reason: `Couldn't remove ${left.slice(0, 3).join(", ")}${left.length > 3 ? ` (+${left.length - 3} more)` : ""}. A nested git repository has to be removed by hand.`,
          });
        }
      }
      return snapshot;
    }),
  );

// Put a discard back. The snapshot's diff against its parent is the
// exact set of paths that went: additions and edits are checked out
// from the snapshot into the working tree, and a file the user had
// deleted is deleted again. Working tree only, so what comes back is
// unstaged, the same as if it had been edited by hand.
export const restoreDiscard = (worktreePath: string, snapshot: string) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      // `--root` makes a parentless snapshot (an unborn-branch discard)
      // diff against the empty tree instead of printing nothing.
      // `--no-commit-id` keeps the hash out of the output.
      const stdout = yield* run(worktreePath, [
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
      ]);
      const fields = splitZ(stdout);
      const restore: string[] = [];
      const remove: string[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i];
        const path = fields[i + 1];
        if (!status || !path) continue;
        if (status.startsWith("D")) remove.push(path);
        else restore.push(path);
      }
      if (restore.length > 0) {
        yield* runChunked(
          worktreePath,
          ["restore", "--worktree", `--source=${snapshot}`],
          restore,
        );
      }
      yield* Effect.promise(() =>
        Promise.all(
          remove.map((path) => rm(join(worktreePath, path), { force: true })),
        ),
      );
    }),
  );
