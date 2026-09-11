// The working tree as the changes page sees it: a list of files to
// tick, commit or throw away. Everything here acts on whole files.
// Hunks staged from a terminal show up as "partial" and are left alone
// unless the file is toggled.
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
import { chunked, run, runLenient, splitZ, type RunOptions } from "./core";

// Discard snapshots kept per repository. Pruned by count rather than
// age, so a repo you touch monthly keeps as useful a tail as one you
// discard in daily.
const DISCARD_SNAPSHOTS_KEPT = 40;
const DISCARD_REF_PREFIX = "refs/shigomori/discards/";

// One git process per chunk of paths, run in order because index writes
// take index.lock. `--literal-pathspecs` because every path here came
// out of `git status` and is a filename, not a pattern: without it a
// file called `a[1].txt` is a glob.
async function runChunked(
  worktreePath: string,
  args: string[],
  paths: readonly string[],
  options?: RunOptions,
): Promise<string[]> {
  const outputs: string[] = [];
  for (const chunk of chunked(paths)) {
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
// index.lock for each, so two quick ticks, or a tick racing a commit,
// would otherwise fail on the lock instead of waiting. A failed task
// doesn't break the chain.
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
// `--no-index` process per new file on every tick is too much. Every
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
    // Look up by what the row is, not just its path: `git rm --cached f`
    // leaves a staged deletion and an untracked file both called f, and
    // the numstat only speaks for the first.
    const counts = isUntracked(file)
      ? untracked.get(file.path)
      : tracked.get(file.path);
    return counts ? { ...file, counts } : file;
  });
}

// `git status --porcelain=v2 -z`, one file per entry. This is the one
// status parser. The sidebar's per-worktree count runs it too.
//
// `untracked: "all"` lists every file of an untracked directory as its
// own row, which the changes page needs so it can diff and discard each
// one. The sidebar scan leaves it unset so a user's
// `status.showUntrackedFiles = no` keeps that scan cheap (see
// getWorkingTreeChanges). `counts` is a second pass over the tree and
// is off by default for the same reason.
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
  return options.counts ? countsFor(worktreePath, files) : files;
}

// What the changes page reads: every file as its own row, with counts.
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
// Answers with a fresh status from the same queue slot, so two quick
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
    // No counts: staging moves the index, and the counts compare the
    // working tree against HEAD. The page keeps the ones it has.
    return listChangedFiles(worktreePath, { untracked: "all" });
  });
}

// --- commit ------------------------------------------------------------

// Commits the index. Two `-m` flags give git the summary and body as
// separate paragraphs. Hooks run as they would in a terminal, and their
// output rides along in the thrown error for the page to show.
// `stagePaths` are added first, in the same queue slot: that is what
// "nothing ticked" means to the commit button. `amend` folds the index
// into HEAD under the new message instead of adding a commit.
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

// A commit's message split the way the composer holds it. `%s` and `%b`
// are git's own split, and a NUL between them survives any subject a
// human could type.
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

// --- undo --------------------------------------------------------------

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

// `git reset --soft`: HEAD moves and nothing else does, so the commits
// between come back as staged changes and no file content is touched.
// Only along HEAD's own line: backwards to an ancestor for an undo, or
// forwards to a descendant for the redo of that undo, which needs the
// caller to pin where HEAD must still be. Anything committed since
// makes it a different branch and the redo is refused. Refused across a
// merge too, since soft-resetting past one stages the whole other side
// as edits, which is nothing anyone means by "undo".
//
// Returns where HEAD was, for the redo.
export function resetSoft(
  worktreePath: string,
  target: string,
  expectHead: string | undefined,
): Promise<string> {
  return onIndex(worktreePath, async () => {
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
  });
}

// --- discard -----------------------------------------------------------

// A commit of `paths` as they sit in the working tree right now, kept
// under refs/shigomori/discards/. Built in a scratch index so the real
// one is untouched: read HEAD's tree in, `add -A` the paths over it
// (that records edits, additions and deletions alike), write the tree
// and wrap it in a commit. The ref keeps the objects alive through gc
// and shows up in `git for-each-ref` for anyone recovering by hand.
// restoreDiscard is the app's own way back.
async function snapshotPaths(
  worktreePath: string,
  paths: readonly string[],
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "shigomori-discard-"));
  const env = {
    GIT_INDEX_FILE: join(scratch, "index"),
    // The snapshot commit's own identity, so a repo with no user.name
    // configured can still discard safely.
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
    // An unborn branch has no HEAD tree to start from, so the snapshot
    // becomes a root commit of just the discarded files.
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
// name sort is newest first. Best effort: a failed prune only leaves an
// extra ref behind.
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
// first so the toast can offer an undo. If the snapshot fails the
// discard is off, since it would be the only copy of the work.
//
// Then: unstage (a staged addition becomes untracked, a staged deletion
// comes back to the index), restore whatever the index now knows from
// it, and clean the rest, which by then is exactly the untracked set.
// Two lists because `restore` refuses paths git doesn't know and
// `clean` ignores paths it does.
export function discardChanges(
  worktreePath: string,
  paths: readonly string[],
): Promise<string> {
  return onIndex(worktreePath, async () => {
    const snapshot = await snapshotPaths(worktreePath, paths);
    await runChunked(worktreePath, ["reset", "-q"], paths);
    const tracked = new Set(
      (await runChunked(worktreePath, ["ls-files", "-z"], paths)).flatMap(
        splitZ,
      ),
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
  });
}

// Put a discard back. The snapshot's diff against its parent is the
// exact set of paths that went: additions and edits are checked out
// from the snapshot into the working tree, and a file the user had
// deleted is deleted again. Working tree only, so what comes back is
// unstaged, the same as if it had been edited by hand.
export function restoreDiscard(
  worktreePath: string,
  snapshot: string,
): Promise<void> {
  return onIndex(worktreePath, async () => {
    // `--root` makes a parentless snapshot (an unborn-branch discard)
    // diff against the empty tree instead of printing nothing.
    // `--no-commit-id` keeps the hash out of the output.
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
  });
}
