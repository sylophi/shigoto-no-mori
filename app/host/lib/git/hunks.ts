// Hunks of one modified file on the changes page: reading them, putting
// the ticked ones in the index for a commit, and throwing one away.
//
// The unit is a change of a zero-context diff of HEAD against the
// working tree, so every change is placed by its line range in HEAD,
// the same range whether it is read off the working tree or off the
// index. A change is in the index when the index's diff against HEAD
// holds the same range with the same new lines. New index and file
// contents are built here from HEAD's lines and the working tree's,
// never by patching, so nothing hangs on context lines lining up.
//
// The page keeps its own ticks, so the index only matters to a discard:
// one that holds the change being thrown away loses it too. An index
// holding something the working tree doesn't (staged, then edited away)
// can't be described as a pick of the working tree's changes, so there
// the index is left alone.
import { isUtf8 } from "node:buffer";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameRange, type FileHunks, type LineChange } from "@shared/schemas";
import { onIndex, snapshotPaths } from "./changes";
import { run } from "./core";

const PATH_OPTS = ["-c", "core.quotePath=false", "--literal-pathspecs"];

const HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

function parseChanges(patch: string): LineChange[] {
  return [...patch.matchAll(HEADER_RE)].map((m) => ({
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  }));
}

// Lines with their endings kept, so a file without a final newline
// comes back without one.
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// Where a change's lines start, 0-based. A zero-length side names the
// line it comes after, so it starts at that number.
const oldFrom = (c: LineChange) =>
  c.oldCount === 0 ? c.oldStart : c.oldStart - 1;
const newFrom = (c: LineChange) =>
  c.newCount === 0 ? c.newStart : c.newStart - 1;

const linesAt = (from: readonly string[], start: number, count: number) =>
  from.slice(start, start + count).join("");

const sameChange = (a: LineChange, b: LineChange) =>
  sameRange(a, b) && a.newStart === b.newStart && a.newCount === b.newCount;

// HEAD with `picked` applied, each change's new lines taken from
// `newer`, whose numbering the changes use.
function applyChanges(
  base: readonly string[],
  newer: readonly string[],
  picked: readonly LineChange[],
): string {
  const out: string[] = [];
  let at = 0;
  for (const change of picked.toSorted((a, b) => a.oldStart - b.oldStart)) {
    const from = oldFrom(change);
    out.push(...base.slice(at, from));
    out.push(
      ...newer.slice(newFrom(change), newFrom(change) + change.newCount),
    );
    at = from + change.oldCount;
  }
  out.push(...base.slice(at));
  return out.join("");
}

// The file's lines and its changes against HEAD. Null when it can't be
// edited by the line: a symlink's text is its target, which a write
// would follow, and text that isn't UTF-8 wouldn't survive being
// decoded and written back.
async function readTree(
  worktreePath: string,
  path: string,
): Promise<{ tree: string[]; changes: LineChange[] } | null> {
  const file = join(worktreePath, path);
  const raw = (await lstat(file)).isSymbolicLink()
    ? null
    : await readFile(file);
  if (raw === null || !isUtf8(raw)) return null;
  const changes = parseChanges(await diffHead(worktreePath, path, false));
  return { tree: splitLines(raw.toString("utf8")), changes };
}

const diffHead = (worktreePath: string, path: string, cached: boolean) =>
  run(worktreePath, [
    ...PATH_OPTS,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "-U0",
    ...(cached ? ["--cached"] : ["HEAD"]),
    "--",
    path,
  ]);

const readHead = async (worktreePath: string, path: string) =>
  splitLines(await run(worktreePath, ["cat-file", "blob", `HEAD:${path}`]));

// Which of the changes the index holds, and whether it holds only
// those. Not `editable` when it holds something the working tree
// doesn't, which no pick of these changes describes.
async function readIndexed(
  worktreePath: string,
  path: string,
  tree: readonly string[],
  changes: readonly LineChange[],
): Promise<{ indexed: LineChange[]; editable: boolean }> {
  const [index, indexDiff] = await Promise.all([
    run(worktreePath, ["cat-file", "blob", `:${path}`]),
    diffHead(worktreePath, path, true),
  ]);
  const indexLines = splitLines(index);
  const staged = parseChanges(indexDiff);
  const indexed = changes.filter((change) =>
    staged.some(
      (s) =>
        sameRange(s, change) &&
        // By content, not line endings: the index holds them clean
        // and a CRLF checkout holds them smudged.
        sameText(
          linesAt(indexLines, newFrom(s), s.newCount),
          linesAt(tree, newFrom(change), change.newCount),
        ),
    ),
  );
  const editable = staged.every((s) => indexed.some((c) => sameRange(c, s)));
  return { indexed, editable };
}

const sameText = (a: string, b: string) =>
  a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");

const WHOLE_ONLY = "This file can only be ticked or discarded whole.";

export async function readHunks(
  worktreePath: string,
  path: string,
): Promise<FileHunks> {
  const [state, head] = await Promise.all([
    readTree(worktreePath, path),
    run(worktreePath, ["rev-parse", "HEAD"]),
  ]);
  return { head: head.trim(), changes: state?.changes ?? [] };
}

// The picks as the file has them now. A pick it no longer has means the
// page is showing an older file. `same` is how close the match has to
// be: a discard wants the very change on screen, a commit only the same
// place in HEAD.
function resolvePicks(
  changes: readonly LineChange[],
  picks: readonly LineChange[],
  same: (a: LineChange, b: LineChange) => boolean,
  stale: string,
): LineChange[] {
  const found = picks.map((pick) => changes.find((c) => same(c, pick)));
  if (found.some((c) => c === undefined)) throw new Error(stale);
  return found as LineChange[];
}

// What a commit says when a file ticked by hunk moved on: opening it
// shows its changes as they are now, with the picks it still has.
export const staleCommit = (path: string) =>
  `${path} changed since its changes were ticked. Open it to check them.`;

async function writeIndexEntry(
  worktreePath: string,
  path: string,
  content: string,
): Promise<void> {
  const [mode = "100644"] = (
    await run(worktreePath, [...PATH_OPTS, "ls-files", "-s", "--", path])
  ).split(" ");
  const scratch = await mkdtemp(join(tmpdir(), "shigomori-hunk-"));
  try {
    const file = join(scratch, "blob");
    await writeFile(file, content);
    // --path runs the file's clean filters, the way `git add` would.
    const blob = (
      await run(worktreePath, [
        "hash-object",
        "-w",
        `--path=${path}`,
        "--",
        file,
      ])
    ).trim();
    await run(worktreePath, [
      "update-index",
      "--cacheinfo",
      `${mode},${blob},${path}`,
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Sets the file's index entry to HEAD plus the picked changes, for a
// commit about to take it. Unqueued: the commit holds the index slot.
export async function stageHunks(
  worktreePath: string,
  path: string,
  picks: readonly LineChange[],
): Promise<void> {
  const [state, head] = await Promise.all([
    readTree(worktreePath, path).catch((err: NodeJS.ErrnoException) => {
      // Deleted since it was listed: not a file to pick from any more.
      throw err.code === "ENOENT" ? new Error(staleCommit(path)) : err;
    }),
    readHead(worktreePath, path),
  ]);
  if (!state) throw new Error(WHOLE_ONLY);
  const picked = resolvePicks(
    state.changes,
    picks,
    sameRange,
    staleCommit(path),
  );
  await writeIndexEntry(
    worktreePath,
    path,
    applyChanges(head, state.tree, picked),
  );
}

// Throws the picked changes away, from the working tree and from the
// index if it holds them, after a snapshot of the file for the undo.
export function discardHunks(
  worktreePath: string,
  path: string,
  picks: readonly LineChange[],
): Promise<string> {
  return onIndex(worktreePath, async () => {
    const state = await readTree(worktreePath, path);
    if (!state) throw new Error(WHOLE_ONLY);
    const { tree, changes } = state;
    const picked = resolvePicks(
      changes,
      picks,
      sameChange,
      `${path} changed since it was shown. Try again.`,
    );
    const [{ indexed, editable }, head] = await Promise.all([
      readIndexed(worktreePath, path, tree, changes),
      readHead(worktreePath, path),
    ]);
    const snapshot = await snapshotPaths(worktreePath, [path]);
    const kept = changes.filter((c) => !picked.includes(c));
    // HEAD's lines as a checkout writes them (line endings and other
    // smudge filters), since these go into the working tree beside the
    // file's own.
    const checkedOut = splitLines(
      await run(worktreePath, ["cat-file", "--filters", `HEAD:${path}`]),
    );
    await writeFile(
      join(worktreePath, path),
      applyChanges(checkedOut, tree, kept),
    );
    if (editable && picked.some((c) => indexed.includes(c))) {
      await writeIndexEntry(
        worktreePath,
        path,
        applyChanges(
          head,
          tree,
          kept.filter((c) => indexed.includes(c)),
        ),
      );
    }
    return snapshot;
  });
}
