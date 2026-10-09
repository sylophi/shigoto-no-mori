// Hunks of one modified file on the changes page: which of them the
// next commit takes, ticking them in and out, and throwing one away.
//
// The unit is a change of a zero-context diff of HEAD against the
// working tree, so every change is placed by its line range in HEAD,
// the same range whether it is read off the working tree or off the
// index. A change is in the index when the index's diff against HEAD
// holds the same range with the same new lines. New index and file
// contents are built here from HEAD's lines and the working tree's,
// never by patching, so nothing hangs on context lines lining up.
//
// An index holding something the working tree doesn't (staged, then
// edited away) can't be described as a pick of the working tree's
// changes, so ticking hunks there is refused: ticking the whole file
// settles it.
import { isUtf8 } from "node:buffer";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChangedFile,
  HunkStates,
  LineChange,
} from "@shigomori/contracts/schemas";
import { listChangedFiles, onIndex, snapshotPaths } from "./changes";
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

const sameRange = (a: LineChange, b: LineChange) =>
  a.oldStart === b.oldStart && a.oldCount === b.oldCount;

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

interface FileState {
  head: string[];
  tree: string[];
  changes: (LineChange & { staged: boolean })[];
  editable: boolean;
  // A symlink, or text that isn't UTF-8: no hunks, the whole file only.
  whole: boolean;
}

async function readState(
  worktreePath: string,
  path: string,
): Promise<FileState> {
  const diff = (cached: boolean) =>
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
  // Only a plain text file is edited by the line: a symlink's text is
  // its target, which a write would follow, and text that isn't UTF-8
  // wouldn't survive being decoded and written back.
  const file = join(worktreePath, path);
  const raw = (await lstat(file)).isSymbolicLink()
    ? null
    : await readFile(file);
  if (raw === null || !isUtf8(raw)) {
    return { head: [], tree: [], changes: [], editable: false, whole: true };
  }
  const [head, index, worktreeDiff, indexDiff] = await Promise.all([
    run(worktreePath, ["cat-file", "blob", `HEAD:${path}`]),
    run(worktreePath, ["cat-file", "blob", `:${path}`]),
    diff(false),
    diff(true),
  ]);
  const headLines = splitLines(head);
  const indexLines = splitLines(index);
  const treeLines = splitLines(raw.toString("utf8"));
  const staged = parseChanges(indexDiff);
  const changes = parseChanges(worktreeDiff).map((change) =>
    Object.assign(change, {
      staged: staged.some(
        (s) =>
          sameRange(s, change) &&
          // By content, not line endings: the index holds them clean
          // and a CRLF checkout holds them smudged.
          sameText(
            linesAt(indexLines, newFrom(s), s.newCount),
            linesAt(treeLines, newFrom(change), change.newCount),
          ),
      ),
    }),
  );
  const editable = staged.every((s) =>
    changes.some((c) => c.staged && sameRange(c, s)),
  );
  return {
    head: headLines,
    tree: treeLines,
    changes,
    editable,
    whole: false,
  };
}

const sameText = (a: string, b: string) =>
  a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");

const WHOLE_ONLY = "This file can only be ticked or discarded whole.";

export async function readHunkStates(
  worktreePath: string,
  path: string,
): Promise<HunkStates> {
  const { changes, editable } = await readState(worktreePath, path);
  return { changes, editable };
}

// The picks as the file has them now. A pick it no longer has means the
// page is showing an older file.
function resolvePicks(state: FileState, picks: readonly LineChange[]) {
  const found = picks.map((pick) =>
    state.changes.find((c) => sameChange(c, pick)),
  );
  if (found.some((c) => c === undefined)) {
    throw new Error("The file changed since it was shown. Try again.");
  }
  return found as FileState["changes"];
}

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

// Ticks the picked changes in or out of the next commit. Answers with
// a fresh status, the way a file tick does.
export function setHunksStaged(
  worktreePath: string,
  path: string,
  picks: readonly LineChange[],
  staged: boolean,
): Promise<ChangedFile[]> {
  return onIndex(worktreePath, async () => {
    const state = await readState(worktreePath, path);
    if (state.whole) throw new Error(WHOLE_ONLY);
    if (!state.editable) {
      throw new Error(
        "The index holds changes this file no longer has. Tick or untick the whole file first.",
      );
    }
    const picked = resolvePicks(state, picks);
    const next = state.changes.filter((c) =>
      picked.includes(c) ? staged : c.staged,
    );
    await writeIndexEntry(
      worktreePath,
      path,
      applyChanges(state.head, state.tree, next),
    );
    return listChangedFiles(worktreePath, { untracked: "all" });
  });
}

// Throws the picked changes away, from the working tree and from the
// index if they were ticked, after a snapshot of the file for the undo.
export function discardHunks(
  worktreePath: string,
  path: string,
  picks: readonly LineChange[],
): Promise<string> {
  return onIndex(worktreePath, async () => {
    const state = await readState(worktreePath, path);
    if (state.whole) throw new Error(WHOLE_ONLY);
    const picked = resolvePicks(state, picks);
    const snapshot = await snapshotPaths(worktreePath, [path]);
    const kept = state.changes.filter((c) => !picked.includes(c));
    // HEAD's lines as a checkout writes them (line endings and other
    // smudge filters), since these go into the working tree beside the
    // file's own.
    const checkedOut = splitLines(
      await run(worktreePath, ["cat-file", "--filters", `HEAD:${path}`]),
    );
    await writeFile(
      join(worktreePath, path),
      applyChanges(checkedOut, state.tree, kept),
    );
    if (state.editable && picked.some((c) => c.staged)) {
      await writeIndexEntry(
        worktreePath,
        path,
        applyChanges(
          state.head,
          state.tree,
          kept.filter((c) => c.staged),
        ),
      );
    }
    return snapshot;
  });
}
