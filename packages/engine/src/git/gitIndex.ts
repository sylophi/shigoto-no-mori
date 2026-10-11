// Git's index: staging, unstaging and committing.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { splitLines, splitZ } from "../gitParse.ts";
import {
  DISCARD_REF_PREFIX,
  DISCARD_SNAPSHOTS_KEPT,
  NestedRepositoryError,
  SHOWN,
  UndoRefusedError,
} from "./documents.ts";
import type { RunningArea } from "./running.ts";
import type { RefsArea } from "./refs.ts";

export const makeGitIndex = ({
  running,
  refs,
}: {
  readonly running: RunningArea;
  readonly refs: RefsArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run, runChunked, onIndex } = running;
    const { verifyRev, refTip, isAncestor } = refs;
    // --- the index ---

    const resetSoft = Effect.fn("Git.resetSoft")(function* (input: {
      readonly worktree: string;
      readonly target: string;
      readonly expectHead?: string | undefined;
    }) {
      const { worktree, target, expectHead } = input;
      return yield* onIndex(
        worktree,
        Effect.gen(function* () {
          const head = yield* verifyRev(worktree, "HEAD");
          if (
            expectHead !== undefined &&
            head !== (yield* verifyRev(worktree, expectHead))
          ) {
            return yield* new UndoRefusedError({ reason: "moved" });
          }
          // Anything committed since makes it a different line, and a
          // revision that doesn't resolve is off it too.
          const onLine = (a: string, b: string) =>
            isAncestor(worktree, a, b).pipe(Effect.orElseSucceed(() => false));
          const range = (yield* onLine(target, head))
            ? [target, head]
            : expectHead !== undefined && (yield* onLine(head, target))
              ? [head, target]
              : undefined;
          if (range === undefined) {
            return yield* new UndoRefusedError({ reason: "off-history" });
          }
          // Soft-resetting past a merge stages its whole other side as
          // edits, which is nothing anyone means by undo.
          const [older, newer] = range;
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
    // DISCARD_SNAPSHOTS_KEPT are kept.
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
          const message = `Discarded from ${path.basename(worktree)}: ${paths.length} file${paths.length === 1 ? "" : "s"}`;
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
          yield* run(worktree, [
            "update-ref",
            `${DISCARD_REF_PREFIX}${yield* Clock.currentTimeMillis}`,
            snapshot,
          ]);
          // Ref names are equal-width millisecond stamps, so a reverse name
          // sort is newest first. Best effort: a failed prune leaves a ref.
          yield* run(worktree, [
            "for-each-ref",
            "--format=%(refname)",
            "--sort=-refname",
            DISCARD_REF_PREFIX,
          ]).pipe(
            Effect.flatMap((stdout) =>
              Effect.forEach(
                splitLines(stdout).slice(DISCARD_SNAPSHOTS_KEPT),
                (ref) => run(worktree, ["update-ref", "-d", ref]),
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

    const restoreDiscard = Effect.fn("Git.restoreDiscard")(function* (input: {
      readonly worktree: string;
      readonly snapshot: string;
    }) {
      const { worktree, snapshot } = input;
      yield* onIndex(
        worktree,
        Effect.gen(function* () {
          // The snapshot's diff against its parent is exactly what went.
          // --root diffs a parentless one (an unborn-branch discard)
          // against the empty tree.
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
            fs
              .remove(path.join(worktree, file), { force: true })
              .pipe(Effect.ignore),
          );
        }),
      );
    });

    return { resetSoft, discard, restoreDiscard };
  });

export type GitIndexArea = Effect.Success<ReturnType<typeof makeGitIndex>>;
