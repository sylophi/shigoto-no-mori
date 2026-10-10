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
import {
  sameRange,
  type FileHunks,
  type LineChange,
} from "@shigomori/contracts/schemas";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { onIndex, snapshotPaths } from "./changes";
import { GitRefusal, run } from "./core";

// The working tree's file could not be read.
class FileReadError extends Schema.TaggedError<FileReadError>()(
  "FileReadError",
  { reason: Schema.String, code: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.reason;
  }
}

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
const readTree = Effect.fnUntraced(function* (
  worktreePath: string,
  path: string,
) {
  const file = join(worktreePath, path);
  const raw = yield* Effect.tryPromise({
    try: async () =>
      (await lstat(file)).isSymbolicLink() ? null : await readFile(file),
    catch: (error) =>
      new FileReadError({
        reason: errorMessageOf(error),
        code: (error as NodeJS.ErrnoException).code ?? null,
      }),
  });
  if (raw === null || !isUtf8(raw)) return null;
  const changes = parseChanges(yield* diffHead(worktreePath, path, false));
  return { tree: splitLines(raw.toString("utf8")), changes };
});

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

const readHead = (worktreePath: string, path: string) =>
  Effect.map(
    run(worktreePath, ["cat-file", "blob", `HEAD:${path}`]),
    splitLines,
  );

// Which of the changes the index holds, and whether it holds only
// those. Not `editable` when it holds something the working tree
// doesn't, which no pick of these changes describes.
const readIndexed = Effect.fnUntraced(function* (
  worktreePath: string,
  path: string,
  tree: readonly string[],
  changes: readonly LineChange[],
) {
  const [index, indexDiff] = yield* Effect.all(
    [
      run(worktreePath, ["cat-file", "blob", `:${path}`]),
      diffHead(worktreePath, path, true),
    ],
    { concurrency: 2 },
  );
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
});

const sameText = (a: string, b: string) =>
  a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");

const WHOLE_ONLY = "This file can only be ticked or discarded whole.";

export const readHunks = Effect.fnUntraced(function* (
  worktreePath: string,
  path: string,
) {
  const [state, head] = yield* Effect.all(
    [readTree(worktreePath, path), run(worktreePath, ["rev-parse", "HEAD"])],
    { concurrency: 2 },
  );
  return {
    head: head.trim(),
    changes: state?.changes ?? [],
  } satisfies FileHunks;
});

// The picks as the file has them now. A pick it no longer has means the
// page is showing an older file. `same` is how close the match has to
// be: a discard wants the very change on screen, a commit only the same
// place in HEAD.
const resolvePicks = (
  changes: readonly LineChange[],
  picks: readonly LineChange[],
  same: (a: LineChange, b: LineChange) => boolean,
  stale: string,
) => {
  const found = picks.map((pick) => changes.find((c) => same(c, pick)));
  return found.some((c) => c === undefined)
    ? Effect.fail(new GitRefusal({ reason: stale }))
    : Effect.succeed(found as LineChange[]);
};

// What a commit says when a file ticked by hunk moved on: opening it
// shows its changes as they are now, with the picks it still has.
export const staleCommit = (path: string) =>
  `${path} changed since its changes were ticked. Open it to check them.`;

const writeIndexEntry = Effect.fnUntraced(function* (
  worktreePath: string,
  path: string,
  content: string,
) {
  const [mode = "100644"] = (yield* run(worktreePath, [
    ...PATH_OPTS,
    "ls-files",
    "-s",
    "--",
    path,
  ])).split(" ");
  yield* Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "shigomori-hunk-"))),
    (scratch) =>
      Effect.gen(function* () {
        const file = join(scratch, "blob");
        yield* Effect.promise(() => writeFile(file, content));
        // --path runs the file's clean filters, the way `git add` would.
        const blob = (yield* run(worktreePath, [
          "hash-object",
          "-w",
          `--path=${path}`,
          "--",
          file,
        ])).trim();
        yield* run(worktreePath, [
          "update-index",
          "--cacheinfo",
          `${mode},${blob},${path}`,
        ]);
      }),
    (scratch) =>
      Effect.promise(() => rm(scratch, { recursive: true, force: true })),
  );
});

// Sets the file's index entry to HEAD plus the picked changes, for a
// commit about to take it. Unqueued: the commit holds the index slot.
export const stageHunks = Effect.fnUntraced(function* (
  worktreePath: string,
  path: string,
  picks: readonly LineChange[],
) {
  const [state, head] = yield* Effect.all(
    [
      readTree(worktreePath, path).pipe(
        // Deleted since it was listed: not a file to pick from any more.
        Effect.catchIf(
          (error) => error instanceof FileReadError && error.code === "ENOENT",
          () => Effect.fail(new GitRefusal({ reason: staleCommit(path) })),
        ),
      ),
      readHead(worktreePath, path),
    ],
    { concurrency: 2 },
  );
  if (!state) return yield* new GitRefusal({ reason: WHOLE_ONLY });
  const picked = yield* resolvePicks(
    state.changes,
    picks,
    sameRange,
    staleCommit(path),
  );
  yield* writeIndexEntry(
    worktreePath,
    path,
    applyChanges(head, state.tree, picked),
  );
});

// Throws the picked changes away, from the working tree and from the
// index if it holds them, after a snapshot of the file for the undo.
export const discardHunks = (
  worktreePath: string,
  path: string,
  picks: readonly LineChange[],
) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      const state = yield* readTree(worktreePath, path);
      if (!state) return yield* new GitRefusal({ reason: WHOLE_ONLY });
      const { tree, changes } = state;
      const picked = yield* resolvePicks(
        changes,
        picks,
        sameChange,
        `${path} changed since it was shown. Try again.`,
      );
      const [{ indexed, editable }, head] = yield* Effect.all(
        [
          readIndexed(worktreePath, path, tree, changes),
          readHead(worktreePath, path),
        ],
        { concurrency: 2 },
      );
      const snapshot = yield* snapshotPaths(worktreePath, [path]);
      const kept = changes.filter((c) => !picked.includes(c));
      // HEAD's lines as a checkout writes them (line endings and other
      // smudge filters), since these go into the working tree beside the
      // file's own.
      const checkedOut = splitLines(
        yield* run(worktreePath, ["cat-file", "--filters", `HEAD:${path}`]),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(worktreePath, path),
          applyChanges(checkedOut, tree, kept),
        ),
      );
      if (editable && picked.some((c) => indexed.includes(c))) {
        yield* writeIndexEntry(
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
    }),
  );
