// Git's diffs: a file's, a commit's, a branch's, as patches, and a
// binary file's two sides by the blob ids its patch names.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { splitZ } from "../gitParse.ts";
import { PATCH_CONFIG, PATCH_FLAGS, PATCH_MAX_OUTPUT } from "./documents.ts";
import type { RunningArea } from "./running.ts";

export const makeDiffs = ({ running }: { readonly running: RunningArea }) =>
  Effect.gen(function* () {
    const { run, runBytes } = running;
    const fs = yield* FileSystem.FileSystem;
    const pathOf = yield* Path.Path;
    const fileDiff = Effect.fn("Git.fileDiff")(function* (input: {
      readonly worktree: string;
      readonly paths: readonly string[];
      readonly untracked: boolean;
    }) {
      const { worktree, paths, untracked } = input;
      const file = paths.at(-1);
      if (file === undefined) return "";
      // A path is a filename, never a pattern: otherwise `a[1].txt` is a
      // glob, and the pane for one file answers with another's hunks.
      const pathspec = ["-c", "core.quotePath=false", "--literal-pathspecs"];
      // `--no-index` reads straight off the disk, so it would answer for a
      // path git doesn't count as a change (an ignored .env). Read-only
      // peers reach this, so git says first whether it is an untracked
      // change. A symlink prints where it points, never what is there.
      if (untracked) {
        // Output past the cap still fails: an answer cut short says
        // nothing about whether the file is there.
        const known = yield* run(
          worktree,
          [
            ...pathspec,
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            file,
          ],
          { anyExit: true },
        ).pipe(Effect.catchTags({ GitCommandError: () => Effect.succeed("") }));
        if (known === "") return "";
      }
      // Full blob ids, since a binary file's new side is read back by
      // its id, and only a full one reaches the disk (isWorkingTreeBlob).
      return yield* run(
        worktree,
        [
          ...pathspec,
          ...PATCH_CONFIG,
          ...(untracked
            ? [
                "diff",
                "--no-index",
                "--no-color",
                "--full-index",
                ...PATCH_FLAGS,
                "--",
                "/dev/null",
                file,
              ]
            : [
                "diff",
                "HEAD",
                "--no-color",
                "--full-index",
                ...PATCH_FLAGS,
                "--",
                ...paths,
              ]),
        ],
        { anyExit: true, maxOutputBytes: PATCH_MAX_OUTPUT, background: true },
      ).pipe(Effect.catchTags({ GitCommandError: () => Effect.succeed("") }));
    });

    const readBlob = Effect.fn("Git.readBlob")(function* (input: {
      readonly repo: string;
      readonly oid: string;
      readonly maxBytes: number;
    }) {
      const object = `${input.oid}^{blob}`;
      const size = yield* run(input.repo, [
        "cat-file",
        "-s",
        "--end-of-options",
        object,
      ]).pipe(
        Effect.map((out) => Option.some(Number(out))),
        Effect.catchTags({
          GitCommandError: () => Effect.succeed(Option.none<number>()),
        }),
      );
      if (Option.isNone(size)) return Option.none();
      if (size.value > input.maxBytes) {
        return Option.some({ size: size.value, bytes: undefined });
      }
      const bytes = yield* runBytes(
        input.repo,
        ["cat-file", "blob", "--end-of-options", object],
        { maxOutputBytes: input.maxBytes },
      );
      return Option.some({ size: bytes.length, bytes });
    });

    // Only by a full id, which the changes page's patch prints
    // (fileDiff's --full-index), and only for what git counts as the
    // worktree's (no ignored .env) as fileDiff is, so no guess reaches a
    // file. A symlink stays out too: a diff shows where it points, never
    // what is there.
    const isWorkingTreeBlob = Effect.fn("Git.isWorkingTreeBlob")(
      function* (input: {
        readonly worktree: string;
        readonly oid: string;
        readonly path: string;
        readonly maxBytes: number;
      }) {
        const { worktree, oid, path } = input;
        if (oid.length < 40) return false;
        const listed = yield* run(worktree, [
          "--literal-pathspecs",
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          path,
        ]);
        if (!splitZ(listed).includes(path)) return false;
        const file = pathOf.join(worktree, path);
        const isLink = yield* fs.readLink(file).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (isLink) return false;
        // Sized before hashing, which reads the whole file. Not a pipe
        // either, which would hold hash-object waiting for a writer.
        const info = yield* fs.stat(file);
        if (info.type !== "File" || Number(info.size) > input.maxBytes) {
          return false;
        }
        const hash = yield* run(worktree, ["hash-object", "--", path]);
        return hash.trim() === oid;
      },
      Effect.orElseSucceed(() => false),
    );

    return { fileDiff, readBlob, isWorkingTreeBlob };
  });
