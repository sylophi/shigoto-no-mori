// Git's working tree: status, changes, cleaning and resetting.
import type { ChangeCounts, ChangedFile } from "@shigomori/contracts/schemas";
import { isUntracked } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parseNumstat, parseStatus } from "../gitParse.ts";
import {
  BINARY_SNIFF_BYTES,
  CHANGE_MTIME_STATS,
  UNTRACKED_COUNT_FILES,
  UNTRACKED_COUNT_LIMIT,
} from "./documents.ts";
import type { RunningArea } from "./running.ts";

export const makeWorkingTree = ({
  running,
}: {
  readonly running: RunningArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run } = running;
    const status = Effect.fn("Git.status")(function* (worktree: string) {
      return parseStatus(
        yield* run(worktree, ["status", "--porcelain=v2", "-z"]),
      );
    });

    // Each file of an untracked folder its own entry, whatever the
    // user's status.showUntrackedFiles. The changes list, every count of
    // changes and the remove, adopt and apply guards read this one list,
    // so they agree.
    const changedFiles = Effect.fn("Git.changedFiles")(function* (
      worktree: string,
    ) {
      return parseStatus(
        yield* run(worktree, [
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
        ]),
      );
    });

    // A new file's lines, all additions. Not a symlink's target, which
    // git sees as a one-line blob, and nothing too big or binary.
    const countUntracked = (worktree: string, file: string) => {
      const full = path.join(worktree, file);
      return Effect.gen(function* () {
        const isLink = yield* fs.readLink(full).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (isLink) return undefined;
        const info = yield* fs.stat(full);
        if (info.type !== "File" || Number(info.size) > UNTRACKED_COUNT_LIMIT) {
          return undefined;
        }
        const contents = yield* fs.readFile(full);
        if (contents.subarray(0, BINARY_SNIFF_BYTES).includes(0))
          return undefined;
        let additions = 0;
        for (
          let at = contents.indexOf(0x0a);
          at !== -1;
          at = contents.indexOf(0x0a, at + 1)
        ) {
          additions++;
        }
        // A last line without its newline is still a line.
        if (contents.length > 0 && contents.at(-1) !== 0x0a) additions++;
        return { additions, deletions: 0 } satisfies ChangeCounts;
      }).pipe(
        // Gone since the listing, or unreadable: the row lists without counts.
        Effect.orElseSucceed(() => undefined),
      );
    };

    const changes = Effect.fn("Git.changes")(function* (worktree: string) {
      // One `diff HEAD --numstat` covers everything git knows about, and
      // needs nothing from the listing. New files are counted one at a
      // time, so an unignored build directory holds one file's bytes in
      // memory, not all of them.
      const [files, tracked] = yield* Effect.all(
        [
          changedFiles(worktree),
          // diff-index, which never writes the index back (see the runner),
          // `-M` for the renames porcelain diff finds.
          run(worktree, [
            "-c",
            "core.quotePath=false",
            "diff-index",
            "-M",
            "--numstat",
            "-z",
            "HEAD",
          ]).pipe(
            Effect.orElseSucceed(() => ""),
            Effect.map(parseNumstat),
          ),
        ],
        { concurrency: 2 },
      );
      // Past a thousand new files it is a folder nobody meant to commit
      // (a build, a node_modules), and its rows list without counts
      // rather than every file being read on every change.
      const newFiles = files.filter(isUntracked);
      const untracked = new Map(
        newFiles.length > UNTRACKED_COUNT_FILES
          ? []
          : yield* Effect.forEach(newFiles, (file) =>
              countUntracked(worktree, file.path).pipe(
                Effect.map((counts) => [file.path, counts] as const),
              ),
            ),
      );
      const counted: ChangedFile[] = [];
      for (const file of files) {
        // By what the row is, not just its path: `git rm --cached f`
        // leaves a staged deletion and an untracked file both called f.
        const counts = isUntracked(file)
          ? untracked.get(file.path)
          : tracked.get(file.path);
        counted.push(counts ? { ...file, counts } : file);
      }
      return counted;
    });

    const workingTreeChanges = Effect.fn("Git.workingTreeChanges")(function* (
      worktree: string,
    ) {
      const files = yield* changedFiles(worktree);
      // Tracked files first: an unignored folder's new files sort among
      // them by path, and would take every stat. A deleted path fails
      // its stat. Fine: only the newest hit counts.
      const times = yield* Effect.forEach(
        [
          ...files.filter((file) => !isUntracked(file)),
          ...files.filter(isUntracked),
        ].slice(0, CHANGE_MTIME_STATS),
        (file) =>
          fs.stat(path.join(worktree, file.path)).pipe(
            Effect.map((info) =>
              Option.match(info.mtime, {
                onNone: () => 0,
                onSome: (d) => d.getTime(),
              }),
            ),
            Effect.orElseSucceed(() => 0),
          ),
        { concurrency: 8 },
      );
      return { count: files.length, lastChangeAt: Math.max(0, ...times) };
    });

    const changedCount = Effect.fn("Git.changedCount")(function* (
      worktree: string,
    ) {
      return (yield* changedFiles(worktree)).length;
    });

    return { status, changedFiles, changes, workingTreeChanges, changedCount };
  });

export type WorkingTreeArea = Effect.Success<
  ReturnType<typeof makeWorkingTree>
>;
