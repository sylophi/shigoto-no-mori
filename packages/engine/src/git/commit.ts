// Git's commit from the changes page. The page keeps its own ticks
// rather than reading them off the index, so this is where they become
// one: the index goes back to HEAD, the ticked files go in whole, the
// files ticked by hunk go in as HEAD plus their picked changes, and git
// commits that. Whatever was staged before (an agent's `git mv`, a
// terminal's `git add`) goes in only if it is ticked.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { splitZ } from "../gitParse.ts";
import { type CommitRequest, GitRefusedError } from "./documents.ts";
import { type HunksArea, staleCommit } from "./hunks.ts";
import type { RunningArea } from "./running.ts";

export const makeCommit = ({
  running,
  hunks,
}: {
  readonly running: RunningArea;
  readonly hunks: HunksArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { run, runChunked, onIndex, gitPath } = running;
    const { stageHunks } = hunks;

    const commitWith = (worktree: string, message: CommitRequest) =>
      Effect.gen(function* () {
        // A hunk is placed by its lines in HEAD, so picks from before a
        // new HEAD (a commit from a terminal) could name other changes.
        if (message.hunks.length > 0) {
          const head = (yield* run(worktree, ["rev-parse", "HEAD"])).trim();
          const stale = message.hunks.find((pick) => pick.base !== head);
          if (stale) {
            return yield* new GitRefusedError({
              reason: staleCommit(stale.path),
            });
          }
        }
        // By path, not a bare `reset`: that one also drops MERGE_HEAD,
        // and a merge's resolution would commit as an ordinary commit.
        yield* run(worktree, ["reset", "-q", "--", "."]);
        // A file listed and then deleted before the commit (an agent's
        // scratch file) is one git no longer knows, and `add` would
        // refuse the whole lot over it.
        const known = new Set(
          (yield* runChunked(
            worktree,
            ["ls-files", "-z", "--cached", "--others"],
            message.paths,
          )).flatMap(splitZ),
        );
        const paths = message.paths.filter((p) => known.has(p));
        // `--force` for a file staged past .gitignore (`git add -f`),
        // which the reset just unstaged.
        if (paths.length > 0) {
          yield* runChunked(worktree, ["add", "-A", "--force"], paths);
        }
        // Index writes take index.lock, so files go one after another.
        for (const { path, changes } of message.hunks) {
          yield* stageHunks(worktree, path, changes);
        }
        yield* run(worktree, [
          "commit",
          "--quiet",
          ...(message.amend ? ["--amend"] : []),
          ...(message.summary === undefined
            ? ["--no-edit"]
            : [
                "-m",
                message.summary,
                ...(message.description?.trim()
                  ? ["-m", message.description.trim()]
                  : []),
              ]),
        ]);
      });

    // Hooks run as they would in a terminal, and their output rides
    // along in the failure. A commit git refuses (a hook, no identity),
    // or one cut short (the app quitting during a long hook, a caller
    // gone) before it made its commit, puts the index back the way it
    // was, so what a terminal or an agent had staged survives it.
    // Answers with the new commit, short.
    const commitPicks = Effect.fn("Git.commitPicks")(function* (
      worktree: string,
      message: CommitRequest,
    ) {
      return yield* onIndex(
        worktree,
        Effect.gen(function* () {
          const indexFile = yield* gitPath(worktree, "index");
          // A repository nothing was ever added to has no index yet.
          const saved = yield* fs.readFile(indexFile).pipe(Effect.option);
          const headOf = run(worktree, [
            "rev-parse",
            "-q",
            "--verify",
            "HEAD",
          ]).pipe(
            Effect.map((out) => out.trim()),
            Effect.orElseSucceed(() => ""),
          );
          const before = yield* headOf;
          // Put back under git's own lock, so no other git (a terminal's
          // commit) writes the index meanwhile, and only while HEAD is
          // where it was: an index no commit was made from. A lock some
          // git holds leaves the index to it.
          const restore = Effect.gen(function* () {
            const lock = `${indexFile}.lock`;
            // Taken empty, so a lock this made is never one a failed write
            // half filled and left. One another git holds is left to it.
            const held = yield* fs
              .writeFile(lock, new Uint8Array(), { flag: "wx" })
              .pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
            if (!held) return;
            yield* Effect.gen(function* () {
              if ((yield* headOf) !== before) return yield* fs.remove(lock);
              if (Option.isNone(saved)) {
                yield* fs.remove(indexFile, { force: true });
                return yield* fs.remove(lock);
              }
              yield* fs.writeFile(lock, saved.value);
              yield* fs.rename(lock, indexFile);
            }).pipe(
              Effect.onError(() =>
                Effect.ignore(fs.remove(lock, { force: true })),
              ),
            );
          }).pipe(Effect.ignore);
          yield* commitWith(worktree, message).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : restore,
            ),
          );
          return (yield* run(worktree, [
            "rev-parse",
            "--short",
            "HEAD",
          ])).trim();
        }),
      );
    });

    return { commitPicks };
  });
