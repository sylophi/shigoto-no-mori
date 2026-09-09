// The working tree as a list of things to commit or throw away: what
// the changes page ticks, commits and discards. Everything here acts on
// whole files. Hunk-level staging done from a terminal survives (it
// reads as "partial" and is left alone unless the file is toggled).
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  ChangeCounts,
  ChangedFile,
  ChangeKind,
  CommitMessage,
  StagedState,
} from "@shared/schemas";
import { isUntracked } from "@shared/schemas";
import { chunked, run, runLenient, splitZ } from "./core";

// Discard snapshots kept per repository. Old ones are dropped by count,
// not age: a repo you discard in daily and one you touch monthly should
// both keep a useful tail.
const DISCARD_SNAPSHOTS_KEPT = 40;
const DISCARD_REF_PREFIX = "refs/shigomori/discards/";

// One git process per chunk, in order: the index takes a lock, so two
// writers can't overlap.
async function runChunked(
  worktreePath: string,
  args: string[],
  paths: readonly string[],
  options?: Parameters<typeof run>[2],
): Promise<string[]> {
  const outputs: string[] = [];
  for (const chunk of chunked(paths)) {
    // `--literal-pathspecs`: these paths are the ones `git status`
    // reported, so they are filenames. Left as pathspecs, a file called
    // `a[1].txt` is a glob, and the run that was meant to stage or
    // throw away one file reaches whatever else it matches.
    // oxlint-disable-next-line no-await-in-loop -- index writes take index.lock, so chunks have to run one after another
    const output = await run(
      worktreePath,
      ["--literal-pathspecs", ...args, "--", ...chunk],
      options,
    );
    outputs.push(output);
  }
  return outputs;
}

// --- status ------------------------------------------------------------

// The text after the Nth space: porcelain v2 puts a fixed number of
// space-separated fields before the path, and with -z the path itself
// is raw, spaces included.
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

// The two status letters are index-vs-HEAD and worktree-vs-index, and a
// file can carry a different one in each ("AM": added to the index,
// edited since). Whichever side says the file arrived or left is the
// one worth reporting -- the other is an edit on top of that.
function kindOf(x: string, y: string): ChangeKind {
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

// --- index queue -----------------------------------------------------------

// Writes to one worktree's index run one after another. Git takes
// index.lock for each, so two ticks in quick succession (or a tick
// racing a commit) would otherwise fail on the lock rather than wait.
// One chain per worktree path. A failed task doesn't break the chain.
const indexQueues = new Map<string, Promise<unknown>>();

function onIndex<T>(worktreePath: string, task: () => Promise<T>): Promise<T> {
  const previous = indexQueues.get(worktreePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  indexQueues.set(
    worktreePath,
    next.catch(() => undefined),
  );
  return next;
}

// --- line counts -----------------------------------------------------

// `--numstat -z` records are "<adds>\t<dels>\t<path>", except a rename
// leaves the path slot empty and spends two more fields on the old and
// new names. Binary files report "-" for both: they map to undefined
// rather than being left out, so a caller can tell "git says no counts"
// from "git never mentioned it".
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

// An untracked file is in no diff git can be asked for in one go, and
// spawning a `--no-index` per new file is a process each on a read that
// happens on every tick. It is a new file, so every line in it is an
// addition -- count them here. Git's own rules for what it declines to
// count: a NUL byte in the first 8k makes it binary, and past a point
// it is not worth reading a file to put a number beside its name.
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
    // `indexOf` is a native scan; a `for..of` over the bytes would run
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
    // Vanished between the status walk and here, or unreadable. The row
    // is still listed; it just shows no counts.
    return undefined;
  }
}

// The +/- each row shows. One `diff HEAD --numstat` covers everything
// git has a record of -- tracked edits, staged or not, and deletions --
// and the new files it has never heard of are counted from disk. Which
// files those are comes from their own status letters, not from being
// missing here, so a file git declines to count can't be mistaken for
// one: the two reads don't need each other and run together.
//
// The disk reads run one after another. A worktree with an unignored
// build directory can list thousands of new files, and the point is to
// hold one file's bytes at a time rather than all of them.
async function countsFor(
  worktreePath: string,
  files: readonly ChangedFile[],
): Promise<ChangedFile[]> {
  const readUntracked = async () => {
    const counted = new Map<string, ChangeCounts | undefined>();
    for (const file of files.filter(isUntracked)) {
      // oxlint-disable-next-line no-await-in-loop -- one file's bytes in memory at a time, not every file's
      counted.set(file.path, await countUntracked(worktreePath, file.path));
    }
    return counted;
  };
  const [tracked, untracked] = await Promise.all([
    runLenient(worktreePath, [
      "-c",
      "core.quotePath=false",
      "diff",
      "HEAD",
      "--numstat",
      "-z",
    ]).then(parseNumstat),
    readUntracked(),
  ]);
  return files.map((file) => {
    // Which side answers is the row's own business, not a lookup by
    // path: `git rm --cached f` leaves a staged deletion and an
    // untracked file both called f, and the numstat only speaks for
    // the first of them.
    const counts = isUntracked(file)
      ? untracked.get(file.path)
      : tracked.get(file.path);
    return counts ? { ...file, counts } : file;
  });
}

// `git status --porcelain=v2 -z`, one file per entry. This is the one
// status parser: the sidebar's per-worktree count runs it too.
//
// `untracked` picks how untracked directories come out. The changes
// page wants "all" (each file its own row, so the diff view and a
// discard can name it). The per-focus sidebar scan leaves it unset so
// a user's `status.showUntrackedFiles = no` keeps that scan cheap (see
// getWorkingTreeChanges).
//
// `counts` adds the +/- the changes list draws, and is off by default
// for the same reason: it is a second pass over the tree, and a scan
// that only wants the number of files shouldn't pay for it.
export async function listChangedFiles(
  worktreePath: string,
  options: { untracked?: "all"; counts?: boolean } = {},
): Promise<ChangedFile[]> {
  const args = ["status", "--porcelain=v2", "-z"];
  if (options.untracked) args.push(`--untracked-files=${options.untracked}`);
  const stdout = await run(worktreePath, args);
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
        // Both sides of an unmerged path have content; what it needs is
        // resolving, which `conflicted` is what the page reads for.
        kind: "modified",
        staged: "none",
        conflicted: true,
      });
    }
    // "!" (ignored) never appears without --ignored, and "#" headers only
    // with --branch. Anything else is skipped rather than guessed at.
  }
  // Path order, once, here: git emits status in its own order, and
  // every reader of this list -- the rail, the commit, the page's first
  // pick -- wants the same one.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return options.counts ? countsFor(worktreePath, files) : files;
}

// The changes page's read, named once: every changed file, each file's
// own row, and the counts the list draws. Both of its callers -- the
// page's own fetch and the answer a tick settles with -- want exactly
// this, and neither should have to remember which flags mean "the
// changes page".
export function listChangesForPage(
  worktreePath: string,
): Promise<ChangedFile[]> {
  return listChangedFiles(worktreePath, { untracked: "all", counts: true });
}

// --- staging -----------------------------------------------------------

// Tick or untick files in the index. `add -A` so a deleted tracked file
// stages as a removal and an untracked one as an addition. Unstaging is
// `reset` rather than `restore --staged`: restore refuses a path git
// doesn't know (an untracked file that was never ticked) and an unborn
// branch, and reset quietly accepts both.
//
// Answers with the status read in the same queue slot, so two quick
// ticks resolve in order and the later answer is the complete one.
export function setStaged(
  worktreePath: string,
  paths: readonly string[],
  staged: boolean,
): Promise<ChangedFile[]> {
  return onIndex(worktreePath, async () => {
    if (staged) {
      await runChunked(worktreePath, ["add", "-A"], paths);
    } else {
      await runChunked(worktreePath, ["reset", "-q"], paths);
    }
    // No counts: staging moves the index, and the counts are the
    // working tree against HEAD, which the index has no say in. The
    // page carries the ones it already has over to this answer.
    return listChangedFiles(worktreePath, { untracked: "all" });
  });
}

// --- commit ------------------------------------------------------------

// Commits the index. Two `-m` flags give git the summary and body as
// separate paragraphs, which is how it lays out a message anyway. Hooks
// run as they would in a terminal: their output rides along in the
// thrown error for the page to show. `amend` folds the index into HEAD
// under the new message instead of adding a commit.
// `stagePaths` go into the index first, in the same queue slot: what
// "nothing ticked" means to the commit button.
export function commitStaged(
  worktreePath: string,
  message: {
    summary: string;
    description?: string;
    amend?: boolean;
    stagePaths?: readonly string[];
  },
): Promise<string> {
  return onIndex(worktreePath, async () => {
    if (message.stagePaths && message.stagePaths.length > 0) {
      await runChunked(worktreePath, ["add", "-A"], message.stagePaths);
    }
    const args = ["commit", "--quiet"];
    if (message.amend) args.push("--amend");
    args.push("-m", message.summary);
    const body = message.description?.trim();
    if (body) args.push("-m", body);
    await run(worktreePath, args);
    const hash = await run(worktreePath, ["rev-parse", "--short", "HEAD"]);
    return hash.trim();
  });
}

// A commit's message as the composer holds it, for prefilling an amend.
// `%s` and `%b` are git's own split. A NUL between them survives any
// subject a human could type.
export async function readCommitMessage(
  worktreePath: string,
  hash: string,
): Promise<CommitMessage> {
  const stdout = await run(worktreePath, [
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
}

// --- undo ----------------------------------------------------------------

async function revParse(worktreePath: string, rev: string): Promise<string> {
  return (
    await run(worktreePath, ["rev-parse", "--verify", "--end-of-options", rev])
  ).trim();
}

async function isAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await run(worktreePath, [
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      ancestor,
      descendant,
    ]);
    return true;
  } catch {
    return false;
  }
}

// `git reset --soft`: HEAD moves, nothing else does, so the commits
// between come back as staged changes and no file content is touched.
// Only along HEAD's own line -- backwards to an ancestor (an undo), or
// forwards to a descendant when the caller pins where HEAD must still
// be (the redo of that undo. Anything committed since makes it a
// different branch and the redo is refused). Refused across a merge:
// soft-resetting past one stages the whole other side as edits, which
// is nothing anyone means by "undo".
//
// Returns where HEAD was, for the redo.
export function resetSoft(
  worktreePath: string,
  target: string,
  expectHead: string | undefined,
): Promise<string> {
  return onIndex(worktreePath, () =>
    resetSoftNow(worktreePath, target, expectHead),
  );
}

async function resetSoftNow(
  worktreePath: string,
  target: string,
  expectHead: string | undefined,
): Promise<string> {
  const [head, expected] = await Promise.all([
    revParse(worktreePath, "HEAD"),
    expectHead ? revParse(worktreePath, expectHead) : undefined,
  ]);
  if (expected !== undefined && head !== expected) {
    throw new Error(
      "The branch has moved on since this was loaded. Reload and try again.",
    );
  }
  const backwards = await isAncestor(worktreePath, target, head);
  const forwards =
    !backwards && expectHead !== undefined
      ? await isAncestor(worktreePath, head, target)
      : false;
  if (!backwards && !forwards) {
    throw new Error("That commit isn't on this branch's history.");
  }
  const [older, newer] = backwards ? [target, head] : [head, target];
  const merges = (
    await run(worktreePath, [
      "rev-list",
      "--merges",
      "--count",
      "--end-of-options",
      `${older}..${newer}`,
    ])
  ).trim();
  if (merges !== "0") {
    throw new Error("Can't undo across a merge commit.");
  }
  await run(worktreePath, ["reset", "--soft", "--end-of-options", target]);
  return head;
}

// --- discard -----------------------------------------------------------

// Snapshot of the given paths as they sit in the working tree right
// now, as a commit on top of HEAD under refs/shigomori/discards/. Built
// in a scratch index so the real index is untouched: read HEAD's tree
// in, `add -A` the paths over it (records edits, additions and
// deletions alike), write the tree, wrap it in a commit. The ref keeps
// the objects alive through gc and lists in `git for-each-ref` for
// anyone recovering by hand. restoreDiscard is the app's own way back.
async function snapshotPaths(
  worktreePath: string,
  paths: readonly string[],
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "shigomori-discard-"));
  const env = {
    GIT_INDEX_FILE: join(scratch, "index"),
    // Identity for the snapshot commit itself, so a repo whose user has
    // no user.name configured can still discard safely.
    GIT_AUTHOR_NAME: "Shigoto no Mori",
    GIT_AUTHOR_EMAIL: "shigomori@localhost",
    GIT_COMMITTER_NAME: "Shigoto no Mori",
    GIT_COMMITTER_EMAIL: "shigomori@localhost",
  };
  try {
    const head = (
      await runLenient(worktreePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD",
      ])
    ).trim();
    // An unborn branch has no HEAD tree to start from. The snapshot is
    // then a root commit of just the discarded files.
    await run(
      worktreePath,
      head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"],
      { env },
    );
    await runChunked(worktreePath, ["add", "-A"], paths, { env });
    const tree = (await run(worktreePath, ["write-tree"], { env })).trim();
    const args = [
      "commit-tree",
      tree,
      "-m",
      `Discarded from ${basename(worktreePath)}: ${paths.length} file${paths.length === 1 ? "" : "s"}`,
    ];
    if (head) args.push("-p", head);
    const commit = (await run(worktreePath, args, { env })).trim();
    await run(worktreePath, [
      "update-ref",
      `${DISCARD_REF_PREFIX}${Date.now()}`,
      commit,
    ]);
    await pruneDiscardSnapshots(worktreePath);
    return commit;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Ref names are millisecond timestamps of equal width, so a reverse
// name sort is newest-first. Best effort: a failed prune only leaves
// an extra ref behind.
async function pruneDiscardSnapshots(worktreePath: string): Promise<void> {
  try {
    const stdout = await run(worktreePath, [
      "for-each-ref",
      "--format=%(refname)",
      "--sort=-refname",
      DISCARD_REF_PREFIX,
    ]);
    const refs = stdout.split("\n").filter(Boolean);
    await Promise.all(
      refs
        .slice(DISCARD_SNAPSHOTS_KEPT)
        .map((ref) => run(worktreePath, ["update-ref", "-d", ref])),
    );
  } catch (err) {
    console.warn("[changes] discard snapshot prune failed:", err);
  }
}

// Throw away the working-tree changes to `paths`, snapshotting them
// first so the toast can offer an undo. Sequence: unstage (a staged
// addition becomes untracked, a staged deletion comes back to the
// index), restore whatever the index now knows from it, then clean the
// rest -- which by then is exactly the untracked set. Two lists rather
// than one because `restore` refuses paths git doesn't know and `clean`
// ignores paths it does.
//
// The snapshot failing aborts the discard: it is the only copy of the
// work once the tree is reset, so "couldn't back it up" has to mean
// "didn't throw it away".
export function discardChanges(
  worktreePath: string,
  paths: readonly string[],
): Promise<string> {
  return onIndex(worktreePath, () => discardChangesNow(worktreePath, paths));
}

async function discardChangesNow(
  worktreePath: string,
  paths: readonly string[],
): Promise<string> {
  const snapshot = await snapshotPaths(worktreePath, paths);
  await runChunked(worktreePath, ["reset", "-q"], paths);
  const tracked = new Set(
    (await runChunked(worktreePath, ["ls-files", "-z"], paths)).flatMap(splitZ),
  );
  const untracked = paths.filter((p) => !tracked.has(p));
  if (tracked.size > 0) {
    await runChunked(worktreePath, ["restore", "--worktree"], [...tracked]);
  }
  if (untracked.length > 0) {
    // -d: an untracked path can be the last file in a fresh directory.
    await runChunked(worktreePath, ["clean", "-fdq"], untracked);
    // `clean` walks past a nested repository without a word, and the
    // snapshot holds only its gitlink, so "discarded" would be a lie
    // there. Say what stayed instead.
    const left = (
      await runChunked(
        worktreePath,
        ["ls-files", "-z", "--others", "--exclude-standard"],
        untracked,
      )
    ).flatMap(splitZ);
    if (left.length > 0) {
      throw new Error(
        `Couldn't remove ${left.slice(0, 3).join(", ")}${left.length > 3 ? ` (+${left.length - 3} more)` : ""}. A nested git repository has to be removed by hand.`,
      );
    }
  }
  return snapshot;
}

// Put a discard back. The snapshot's own diff against its parent is the
// exact set of paths that went: additions and edits are checked out
// from the snapshot into the working tree, and a file the user had
// deleted is deleted again. Working tree only -- what comes back is
// unstaged, the same as if it had been edited by hand.
export function restoreDiscard(
  worktreePath: string,
  snapshot: string,
): Promise<void> {
  return onIndex(worktreePath, () => restoreDiscardNow(worktreePath, snapshot));
}

async function restoreDiscardNow(
  worktreePath: string,
  snapshot: string,
): Promise<void> {
  // `--root` makes a parentless snapshot (unborn-branch discard) diff
  // against the empty tree instead of printing nothing. Without
  // `--no-commit-id` the hash would lead the output as a field of its own.
  const stdout = await run(worktreePath, [
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
    await runChunked(
      worktreePath,
      ["restore", "--worktree", `--source=${snapshot}`],
      restore,
    );
  }
  await Promise.all(
    remove.map((path) => rm(join(worktreePath, path), { force: true })),
  );
}
