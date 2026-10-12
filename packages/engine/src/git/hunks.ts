// Git's hunks of one modified file on the changes page: reading them,
// putting the ticked ones in the index for a commit, and throwing some
// away.
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
import {
  type FileHunks,
  type LineChange,
  sameRange,
} from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { isNotFound } from "../platformErrors.ts";
import { GitRefusedError } from "./documents.ts";
import type { GitIndexArea } from "./gitIndex.ts";
import type { RunningArea } from "./running.ts";

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

const sameText = (a: string, b: string) =>
  a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");

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

// The picks as the file has them now. A pick it no longer has means
// the page is showing an older file. `same` is how close the match
// has to be: a discard wants the very change on screen, a commit
// only the same place in HEAD.
const resolvePicks = (
  changes: readonly LineChange[],
  picks: readonly LineChange[],
  same: (a: LineChange, b: LineChange) => boolean,
  stale: string,
) => {
  const found = picks.map((pick) => changes.find((c) => same(c, pick)));
  return found.some((c) => c === undefined)
    ? Effect.fail(new GitRefusedError({ reason: stale }))
    : Effect.succeed(found as LineChange[]);
};

const WHOLE_ONLY = "This file can only be ticked or discarded whole.";

// What a commit says when a file ticked by hunk moved on: opening it
// shows its changes as they are now, with the picks it still has.
export const staleCommit = (path: string) =>
  `${path} changed since its changes were ticked. Open it to check them.`;

export const makeHunks = ({
  running,
  gitIndex,
}: {
  readonly running: RunningArea;
  readonly gitIndex: GitIndexArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run, onIndex } = running;
    const { snapshotPaths } = gitIndex;

    const diffHead = (worktree: string, file: string, cached: boolean) =>
      run(worktree, [
        ...PATH_OPTS,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "-U0",
        ...(cached ? ["--cached"] : ["HEAD"]),
        "--",
        file,
      ]);

    const readHead = (worktree: string, file: string) =>
      run(worktree, ["cat-file", "blob", `HEAD:${file}`]).pipe(
        Effect.map(splitLines),
      );

    // The file's lines and its changes against HEAD. Null when it can't
    // be edited by the line: a symlink's text is its target, which a
    // write would follow, and text that isn't UTF-8 wouldn't survive
    // being decoded and written back.
    const readTree = (worktree: string, file: string) =>
      Effect.gen(function* () {
        const full = path.join(worktree, file);
        const symlink = yield* fs.readLink(full).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (symlink) return null;
        const raw = yield* fs.readFile(full);
        if (!isUtf8(raw)) return null;
        const changes = parseChanges(yield* diffHead(worktree, file, false));
        return {
          // A byte order mark stays, as the file has it.
          tree: splitLines(
            new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw),
          ),
          changes,
        };
      });

    // Which of the changes the index holds, and whether it holds only
    // those. Not `editable` when it holds something the working tree
    // doesn't, which no pick of these changes describes.
    const readIndexed = (
      worktree: string,
      file: string,
      tree: readonly string[],
      changes: readonly LineChange[],
    ) =>
      Effect.gen(function* () {
        const [index, indexDiff] = yield* Effect.all(
          [
            run(worktree, ["cat-file", "blob", `:${file}`]),
            diffHead(worktree, file, true),
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
        const editable = staged.every((s) =>
          indexed.some((c) => sameRange(c, s)),
        );
        return { indexed, editable };
      });

    const writeIndexEntry = (worktree: string, file: string, content: string) =>
      Effect.gen(function* () {
        const [mode = "100644"] = (yield* run(worktree, [
          ...PATH_OPTS,
          "ls-files",
          "-s",
          "--",
          file,
        ])).split(" ");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const scratch = yield* fs.makeTempDirectoryScoped({
              prefix: "shigomori-hunk-",
            });
            const blobFile = path.join(scratch, "blob");
            yield* fs.writeFileString(blobFile, content);
            // --path runs the file's clean filters, the way `git add`
            // would.
            const blob = (yield* run(worktree, [
              "hash-object",
              "-w",
              `--path=${file}`,
              "--",
              blobFile,
            ])).trim();
            yield* run(worktree, [
              "update-index",
              "--cacheinfo",
              `${mode},${blob},${file}`,
            ]);
          }),
        );
      });

    const readHunks = Effect.fn("Git.readHunks")(function* (
      worktree: string,
      file: string,
    ) {
      const [state, head] = yield* Effect.all(
        [readTree(worktree, file), run(worktree, ["rev-parse", "HEAD"])],
        { concurrency: 2 },
      );
      return {
        head: head.trim(),
        changes: state?.changes ?? [],
      } satisfies FileHunks;
    });

    // Sets the file's index entry to HEAD plus the picked changes, for a
    // commit about to take it. Unqueued: the commit holds the index lock.
    const stageHunks = (
      worktree: string,
      file: string,
      picks: readonly LineChange[],
    ) =>
      Effect.gen(function* () {
        const [state, head] = yield* Effect.all(
          [
            readTree(worktree, file).pipe(
              // Deleted since it was listed: not a file to pick from any
              // more.
              Effect.catchIf(
                (error) =>
                  error instanceof PlatformError.PlatformError &&
                  isNotFound(error),
                () =>
                  Effect.fail(
                    new GitRefusedError({ reason: staleCommit(file) }),
                  ),
              ),
            ),
            readHead(worktree, file),
          ],
          { concurrency: 2 },
        );
        if (!state) return yield* new GitRefusedError({ reason: WHOLE_ONLY });
        const picked = yield* resolvePicks(
          state.changes,
          picks,
          sameRange,
          staleCommit(file),
        );
        yield* writeIndexEntry(
          worktree,
          file,
          applyChanges(head, state.tree, picked),
        );
      });

    // Throws the picked changes away, from the working tree and from the
    // index if it holds them, after a snapshot of the file for the undo.
    const discardHunks = Effect.fn("Git.discardHunks")(function* (input: {
      readonly worktree: string;
      readonly path: string;
      readonly changes: readonly LineChange[];
    }) {
      const { worktree, path: file, changes: picks } = input;
      return yield* onIndex(
        worktree,
        Effect.gen(function* () {
          const state = yield* readTree(worktree, file);
          if (!state) {
            return yield* new GitRefusedError({ reason: WHOLE_ONLY });
          }
          const { tree, changes } = state;
          const picked = yield* resolvePicks(
            changes,
            picks,
            sameChange,
            `${file} changed since it was shown. Try again.`,
          );
          const [{ indexed, editable }, head] = yield* Effect.all(
            [
              readIndexed(worktree, file, tree, changes),
              readHead(worktree, file),
            ],
            { concurrency: 2 },
          );
          const snapshot = yield* snapshotPaths(worktree, [file]);
          const kept = changes.filter((c) => !picked.includes(c));
          // HEAD's lines as a checkout writes them (line endings and other
          // smudge filters), since these go into the working tree beside
          // the file's own.
          const checkedOut = splitLines(
            yield* run(worktree, ["cat-file", "--filters", `HEAD:${file}`]),
          );
          yield* fs.writeFileString(
            path.join(worktree, file),
            applyChanges(checkedOut, tree, kept),
          );
          if (editable && picked.some((c) => indexed.includes(c))) {
            yield* writeIndexEntry(
              worktree,
              file,
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
    });

    return { readHunks, stageHunks, discardHunks };
  });

export type HunksArea = Effect.Success<ReturnType<typeof makeHunks>>;
