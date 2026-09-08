// The working tree as a list of things to commit or throw away: what
// the changes page ticks, commits and discards. Everything here acts on
// whole files. Hunk-level staging done from a terminal survives (it
// reads as "partial" and is left alone unless the file is toggled).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChangedFile, CommitMessage, StagedState } from "@shared/schemas";
import { chunked, onIndex, run, runLenient, splitZ } from "./core";

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
    // oxlint-disable-next-line no-await-in-loop -- index writes take index.lock, so chunks have to run one after another
    outputs.push(await run(worktreePath, [...args, "--", ...chunk], options));
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

// `git status --porcelain=v2 -z`, one file per entry. This is the one
// status parser: the sidebar's per-worktree count runs it too.
//
// `untracked` picks how untracked directories come out. The changes
// page wants "all" (each file its own row, so the patch view and a
// discard can name it). The per-focus sidebar scan leaves it unset so
// a user's `status.showUntrackedFiles = no` keeps that scan cheap (see
// getWorkingTreeChanges).
export async function listChangedFiles(
  worktreePath: string,
  options: { untracked?: "all" } = {},
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
      files.push({ path: record.slice(2), staged: "none" });
    } else if (type === "1") {
      files.push({
        path: afterNthSpace(record, 8),
        staged: stagedOf(record[2] ?? ".", record[3] ?? "."),
      });
    } else if (type === "2") {
      // Rename/copy: the original path follows as its own NUL field.
      const staged = stagedOf(record[2] ?? ".", record[3] ?? ".");
      const prevPath = fields[++i];
      files.push({ path: afterNthSpace(record, 9), prevPath, staged });
    } else if (type === "u") {
      files.push({
        path: afterNthSpace(record, 10),
        staged: "none",
        conflicted: true,
      });
    }
    // "!" (ignored) never appears without --ignored, and "#" headers only
    // with --branch. Anything else is skipped rather than guessed at.
  }
  return files;
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
