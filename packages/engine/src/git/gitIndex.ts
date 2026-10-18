// Git's index: undoing commits, hard resets, and discarding changes into snapshots that put them back.
import { pluralize } from "@shigomori/contracts/words";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { splitLines, splitZ } from "../gitParse.ts";
import { isUntracked } from "@shigomori/contracts/schemas";
import {
  ABSENT_REF,
  DISCARD_REF_PREFIX,
  DISCARD_SNAPSHOTS_KEPT,
  GitCommandError,
  GitRefusedError,
  listed,
  NestedRepositoryError,
  SHOWN,
  stderrOf,
  UndoRefusedError,
} from "./documents.ts";
import type { OperationArea } from "./operation.ts";
import type { RunningArea } from "./running.ts";
import type { RefsArea } from "./refs.ts";
import type { WorkingTreeArea } from "./workingTree.ts";

export const makeGitIndex = ({
  running,
  refs,
  operation,
  workingTree,
}: {
  readonly running: RunningArea;
  readonly refs: RefsArea;
  readonly operation: OperationArea;
  readonly workingTree: WorkingTreeArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run, runChunked, onIndex } = running;
    const { verifyRev, refTip, isAncestor, headAt, resolveCommit } = refs;
    const { status } = workingTree;
    // `reset --soft`: HEAD moves and nothing else does, so the commits
    // between come back as staged changes. Only along HEAD's own line:
    // back to an ancestor for an undo, or forward to a descendant for
    // that undo's redo, which pins where HEAD must still be. Refused
    // across a merge, since soft-resetting past one stages its whole
    // other side as edits. A merge on top, undone to its first parent,
    // comes off whole instead (`reset --keep`, which refuses rather than
    // lose a local edit), and its redo puts it back. Answers with where
    // HEAD was, for the redo.
    const resetSoft = Effect.fn("Git.resetSoft")(function* (input: {
      readonly worktree: string;
      readonly target: string;
      readonly expectHead?: string | undefined;
    }) {
      const { worktree, target, expectHead } = input;
      return yield* onIndex(
        worktree,
        Effect.gen(function* () {
          yield* operation.refuseMidOperation(worktree);
          const head = yield* headAt(worktree, expectHead);
          // A revision that doesn't resolve is off the line too.
          const onLine = (a: string, b: string) =>
            isAncestor(worktree, a, b).pipe(Effect.orElseSucceed(() => false));
          const backwards = yield* onLine(target, head);
          const forwards =
            !backwards && expectHead !== undefined
              ? yield* onLine(head, target)
              : false;
          if (!backwards && !forwards) {
            return yield* new UndoRefusedError({ reason: "off-history" });
          }
          const [older, newer] = backwards ? [target, head] : [head, target];
          // One merge, stepped over to its first parent and back: the
          // merge comes off (or goes back on) whole.
          const firstParent = yield* verifyRev(worktree, `${newer}^1`).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const wholeMerge =
            firstParent !== undefined &&
            (yield* verifyRev(worktree, older)) === firstParent &&
            (yield* verifyRev(worktree, `${newer}^2`).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ));
          if (wholeMerge) {
            yield* run(worktree, [
              "reset",
              "--keep",
              "--end-of-options",
              target,
            ]);
            return head;
          }
          const merges = yield* run(worktree, [
            "rev-list",
            "--merges",
            "--count",
            "--end-of-options",
            `${older}..${newer}`,
          ]);
          if (merges.trim() !== "0") {
            return yield* new UndoRefusedError({ reason: "across-merge" });
          }
          yield* run(worktree, ["reset", "--soft", "--end-of-options", target]);
          return head;
        }),
      );
    });

    // A commit of `paths` as they are on disk now, under
    // DISCARD_REF_PREFIX, built in a scratch index so the real one is
    // untouched. The ref keeps its objects through gc, and the newest
    // DISCARD_SNAPSHOTS_KEPT, by number, are kept.
    const snapshotPaths = (worktree: string, paths: readonly string[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          // No temp dir means a broken machine, not a refusal to discard.
          const scratch = yield* fs
            .makeTempDirectoryScoped({ prefix: "shigomori-discard-" })
            .pipe(Effect.orDie);
          const env = {
            GIT_INDEX_FILE: path.join(scratch, "index"),
            // The snapshot's own identity, so a repo without user.name can
            // still discard safely.
            GIT_AUTHOR_NAME: "Shigoto no Mori",
            GIT_AUTHOR_EMAIL: "shigomori@localhost",
            GIT_COMMITTER_NAME: "Shigoto no Mori",
            GIT_COMMITTER_EMAIL: "shigomori@localhost",
          };
          const head = yield* refTip(worktree, "HEAD");
          // An unborn branch has no tree to start from: the snapshot is a
          // root commit of just the discarded files.
          yield* run(
            worktree,
            Option.isSome(head)
              ? ["read-tree", "HEAD"]
              : ["read-tree", "--empty"],
            { env },
          );
          yield* runChunked(worktree, ["add", "-A"], paths, { env });
          const tree = (yield* run(worktree, ["write-tree"], { env })).trim();
          const message = `Discarded from ${path.basename(worktree)}: ${pluralize(paths.length, "file")}`;
          const snapshot = (yield* run(
            worktree,
            [
              "commit-tree",
              tree,
              "-m",
              message,
              ...(Option.isSome(head) ? ["-p", head.value] : []),
            ],
            { env },
          )).trim();
          // Named by a number one past the repository's highest and made
          // only where no ref is yet, so a snapshot from another worktree
          // taking the number first sends this one to the next, and no
          // clock orders them.
          const numbered = run(worktree, [
            "for-each-ref",
            "--format=%(refname)",
            DISCARD_REF_PREFIX,
          ]).pipe(
            Effect.map((stdout) =>
              splitLines(stdout).flatMap((ref) => {
                const name = ref.slice(DISCARD_REF_PREFIX.length);
                return /^[1-9]\d*$/.test(name) ? [Number(name)] : [];
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const highest = (yield* numbered).reduce(
              (a, b) => Math.max(a, b),
              0,
            );
            yield* run(worktree, [
              "update-ref",
              `${DISCARD_REF_PREFIX}${highest + 1}`,
              snapshot,
              ABSENT_REF,
            ]);
          }).pipe(
            Effect.retry({
              times: 8,
              // Taken by another snapshot since it was read, or held by
              // its write: either way the next number is free.
              while: (error) =>
                error instanceof GitCommandError &&
                /reference already exists|cannot lock ref/.test(
                  stderrOf(error),
                ),
            }),
          );
          // Best effort: a failed prune leaves a ref.
          yield* numbered.pipe(
            Effect.flatMap((numbers) =>
              Effect.forEach(
                numbers.toSorted((a, b) => b - a).slice(DISCARD_SNAPSHOTS_KEPT),
                (n) =>
                  run(worktree, [
                    "update-ref",
                    "-d",
                    `${DISCARD_REF_PREFIX}${n}`,
                  ]),
              ),
            ),
            Effect.ignore,
          );
          return snapshot;
        }),
      );

    const discard = Effect.fn("Git.discard")(function* (input: {
      readonly worktree: string;
      readonly paths: readonly string[];
    }) {
      const { worktree, paths } = input;
      return yield* onIndex(
        worktree,
        Effect.gen(function* () {
          // Without its snapshot the discard is off: that would be the
          // only copy of the work.
          const snapshot = yield* snapshotPaths(worktree, paths);
          // Unstaged first (a staged addition becomes untracked, a staged
          // deletion comes back), then whatever the index knows is
          // restored and the rest, the untracked set, is cleaned. Two
          // lists, since `restore` refuses paths git doesn't know and
          // `clean` ignores paths it does.
          yield* runChunked(worktree, ["reset", "-q"], paths);
          const tracked = new Set(
            (yield* runChunked(worktree, ["ls-files", "-z"], paths)).flatMap(
              splitZ,
            ),
          );
          const untracked = paths.filter((p) => !tracked.has(p));
          if (tracked.size > 0)
            yield* runChunked(
              worktree,
              ["restore", "--worktree"],
              [...tracked],
            );
          if (untracked.length > 0) {
            // -d: an untracked path can be the last file in a new folder.
            yield* runChunked(worktree, ["clean", "-fdq"], untracked);
            const left = (yield* runChunked(
              worktree,
              ["ls-files", "-z", "--others", "--exclude-standard"],
              untracked,
            )).flatMap(splitZ);
            if (left.length > 0) {
              return yield* new NestedRepositoryError({
                paths: left.slice(0, SHOWN),
                count: left.length,
              });
            }
          }
          return snapshot;
        }),
      );
    });

    // Puts a snapshot back in the working tree only, so what comes back
    // is unstaged, as if edited by hand. Its diff against its parent is
    // exactly what went: --root diffs a parentless one (an unborn-branch
    // discard) against the empty tree.
    const restoreSnapshot = (worktree: string, snapshot: string) =>
      Effect.gen(function* () {
        const fields = splitZ(
          yield* run(worktree, [
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
          ]),
        );
        const restore: string[] = [];
        const remove: string[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const [state, file] = [fields[i], fields[i + 1]];
          if (!state || !file) continue;
          (state.startsWith("D") ? remove : restore).push(file);
        }
        if (restore.length > 0) {
          yield* runChunked(
            worktree,
            ["restore", "--worktree", `--source=${snapshot}`],
            restore,
          );
        }
        yield* Effect.forEach(remove, (file) =>
          fs.remove(path.join(worktree, file), { force: true }),
        );
      });

    const restoreDiscard = Effect.fn("Git.restoreDiscard")(function* (input: {
      readonly worktree: string;
      readonly snapshot: string;
    }) {
      yield* onIndex(
        input.worktree,
        restoreSnapshot(input.worktree, input.snapshot),
      );
    });

    // `reset --hard`: the branch, the index and the working tree all move
    // to `ref`, wherever it is. What it throws away can come back: the
    // commits through the previous HEAD it answers with, and the files it
    // overwrites through a discard snapshot taken first, for
    // restoreDiscard. Those are the uncommitted changes to tracked files,
    // and the untracked files where `ref` tracks the same path. Every
    // other untracked file stays. `expectHead` pins HEAD to where the
    // page that asked last saw it.
    //
    // The only paths the reset can overwrite untracked are those `ref`
    // tracks and HEAD doesn't, so one divergence-sized listing finds them.
    // `--no-renames`, or a rename reads as R, not A, and its destination
    // slips through. Git itself then says which of those are on disk
    // (`ls-files -o` with them as pathspecs): an exists-check would
    // false-positive on case-insensitive APFS after a case-only rename.
    // An ignored file among them (a carried-over `.env` colliding with a
    // committed one) never was in git, and a snapshot can't hold it, so
    // that refuses.
    //
    // The undo resets back to the previous HEAD, pinned to where this one
    // left it, and puts the snapshot back (`restore`). Anything changed
    // since would be overwritten by it, so that refuses too.
    const resetHard = Effect.fn("Git.resetHard")(function* (input: {
      readonly worktree: string;
      readonly ref: string;
      readonly expectHead?: string | undefined;
      readonly restore?: string | undefined;
    }) {
      const { worktree, ref, expectHead, restore } = input;
      return yield* onIndex(
        worktree,
        Effect.gen(function* () {
          // The refusals first, and only then the status: a refusal that
          // cut a status short could leave its index.lock behind.
          const [, previousHead, target] = yield* Effect.all(
            [
              operation.refuseMidOperation(worktree),
              headAt(worktree, expectHead),
              resolveCommit(worktree, ref),
            ],
            { concurrency: "unbounded" },
          );
          const changed = yield* status(worktree);
          const added = splitZ(
            yield* run(worktree, [
              "diff",
              "--name-only",
              "--no-renames",
              "--diff-filter=A",
              "-z",
              "HEAD",
              target,
            ]),
          );
          const others = (extra: readonly string[]) =>
            runChunked(
              worktree,
              ["ls-files", "-z", "--others", "--exclude-standard", ...extra],
              added,
            ).pipe(Effect.map((out) => out.flatMap(splitZ)));
          const [overwritten, ignored] = yield* Effect.all(
            [others([]), others(["--ignored"])],
            { concurrency: 2 },
          );
          if (ignored.length > 0) {
            return yield* new GitRefusedError({
              reason: `This would replace ignored local file(s) that ${ref} tracks: ${listed(ignored.slice(0, SHOWN), ignored.length)}. Move them aside first.`,
            });
          }
          const paths = [
            ...changed
              .filter((f) => !isUntracked(f))
              .flatMap((f) => (f.prevPath ? [f.path, f.prevPath] : [f.path])),
            ...overwritten,
          ];
          if (restore && paths.length > 0) {
            return yield* new GitRefusedError({
              reason:
                "Files changed since the hard reset. Commit, stash, or discard them first.",
            });
          }
          const snapshot =
            paths.length > 0 ? yield* snapshotPaths(worktree, paths) : null;
          // Quiet: what it prints is never read, and a subject past the
          // output cap would fail the reset with the snapshot unnamed.
          yield* run(worktree, [
            "reset",
            "--hard",
            "--quiet",
            "--end-of-options",
            target,
          ]).pipe(
            Effect.mapError((error) =>
              snapshot !== null && error instanceof GitCommandError
                ? new GitCommandError({
                    subcommand: error.subcommand,
                    exitCode: error.exitCode,
                    cause: new Error(
                      `${stderrOf(error)}\nThe uncommitted changes were snapshotted first, as ${snapshot}.`,
                    ),
                  })
                : error,
            ),
          );
          if (restore) yield* restoreSnapshot(worktree, restore);
          return { previousHead, head: target, snapshot };
        }),
      );
    });

    return { resetSoft, resetHard, snapshotPaths, discard, restoreDiscard };
  });

export type GitIndexArea = Effect.Success<ReturnType<typeof makeGitIndex>>;
