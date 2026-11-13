// Worktrees' removing: the guards a removal passes, the teardown, and
// the checkout and branch going.
//
// git's remove is its commit point. A git killed before the `.git` went
// leaves a checkout that reads as dirty, which a forced removal takes,
// or as clean if only ignored files went (`--skip-cleanup` gets past a
// teardown that fails on what is left). One killed after leaves a
// half-removed checkout (below).
import { lifecycleCommand } from "@shigomori/contracts/lifecycleScripts";
import type { LifecycleSlot } from "@shigomori/contracts/schemas/scripts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { movedSourceChange } from "@shigomori/contracts/movedSource";
import type { MovedSource } from "@shigomori/contracts/schemas";
import * as Config from "../Config.ts";
import * as Dirty from "../Dirty.ts";
import * as Git from "../Git.ts";
import { HoldersOnDelete } from "../HoldersOnDelete.ts";
import {
  type DeleteEnd,
  MirrorsOnDelete,
  type Stopped,
} from "../MirrorsOnDelete.ts";
import { removeEmptyFolder } from "../entries.ts";
import * as Paths from "../Paths.ts";
import { byPlatform } from "../platform.ts";
import { isNotFound } from "../platformErrors.ts";
import { ownedLevels } from "../worktreeLayout.ts";
import {
  CleanupFailed,
  DirtyWorktree,
  type Located,
  OrphanedWorktree,
  type Reporter,
  UNKNOWN_BRANCH,
  type WorktreeIdentity,
  WorktreeRefused,
} from "./documents.ts";
import type { ListingArea } from "./listing.ts";
import type { CreatingArea } from "./creating.ts";
import type { KeptArea } from "./kept.ts";

const notPrimary = (worktree: WorktreeIdentity) =>
  worktree.isPrimary
    ? Effect.fail(
        new WorktreeRefused({
          reason: "remove-primary",
          subject: worktree.path,
        }),
      )
    : Effect.void;

// The worktree's mirror stopped before its files go
// (MirrorsOnDelete.ts). One that can't be is a delete refused.
const stopMirrors = (projectId: string, worktree: WorktreeIdentity) =>
  Effect.flatMap(
    Effect.serviceOption(MirrorsOnDelete),
    (mirrors): Effect.Effect<Stopped, WorktreeRefused> =>
      Option.isNone(mirrors)
        ? Effect.succeed(() => Effect.void)
        : mirrors.value.stop({ projectId, worktreeId: worktree.id }).pipe(
            Effect.mapError(
              (cause) =>
                new WorktreeRefused({
                  reason: "mirror-not-stopped",
                  subject: worktree.path,
                  cause,
                }),
            ),
          ),
  );

// What the app runs in the worktree let go before its files go
// (HoldersOnDelete.ts).
const releaseHolders = (projectId: string, worktree: WorktreeIdentity) =>
  Effect.flatMap(Effect.serviceOption(HoldersOnDelete), (holders) =>
    Option.isNone(holders)
      ? Effect.void
      : holders.value.release({ projectId, worktreeId: worktree.id }),
  );

export const makeRemoving = ({
  listing,
  creating,
  kept,
}: {
  readonly listing: ListingArea;
  readonly creating: CreatingArea;
  readonly kept: KeptArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const dirty = yield* Dirty.Dirty;
    const config = yield* Config.Config;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const { projectSettings, primaryRefOf } = listing;
    const { scriptContextOf, runScript, portPoolActive } = creating;

    // Fails closed on a dirty or unreadable worktree, since the next
    // step destroys the folder.
    const requireClean = (
      worktree: WorktreeIdentity,
      force: boolean,
      verb: string,
      destroys: string,
    ) =>
      force
        ? Effect.void
        : git.changedCount(worktree.path).pipe(
            Effect.mapError(
              (cause) =>
                new DirtyWorktree({
                  reason: "unreadable",
                  count: 0,
                  verb,
                  destroys,
                  cause:
                    cause instanceof Git.GitCommandError
                      ? new Error(Git.stderrOf(cause))
                      : cause,
                }),
            ),
            Effect.flatMap((count) =>
              count === 0
                ? Effect.void
                : Effect.fail(
                    new DirtyWorktree({
                      reason: "uncommitted",
                      count,
                      verb,
                      destroys,
                    }),
                  ),
            ),
          );

    // An admin dir that is definitely gone: an unreadable one must not
    // pass for a finished sweep.
    const gone = (dir: string) =>
      fs.stat(dir).pipe(
        Effect.as(false),
        Effect.catchIf(isNotFound, () => Effect.succeed(true)),
        Effect.orElseSucceed(() => false),
      );

    // rm -rf, retried for a few seconds while a folder keeps refilling: the
    // writer that defeated git's sweep may still be landing files. On
    // Windows also while a file or folder is held, as an antivirus or the
    // indexer holds one for a moment. A hold that outlasts the tries (a
    // process working in the folder) fails the wipe with it.
    const wipe = (dir: string) =>
      fs.remove(dir, { recursive: true, force: true }).pipe(
        Effect.retry({
          while: (error) =>
            Predicate.hasProperty(error.cause, "code") &&
            byPlatform({
              darwin: ["ENOTEMPTY"],
              linux: ["ENOTEMPTY"],
              win32: ["ENOTEMPTY", "EBUSY", "EPERM"],
            }).includes(String(error.cause.code)),
          // Five seconds in tries, which no clock step shortens.
          schedule: Schedule.spaced("250 millis").pipe(
            Schedule.upTo({ times: 20 }),
          ),
        }),
      );

    // `git worktree remove`, finishing the sweep when git couldn't. Git
    // drops its admin entry whether or not the sweep finished, so a sweep
    // a watcher outran leaves a folder no later remove can reach. The wipe
    // takes only what git had agreed to delete: it runs when the admin
    // entry was there before and is gone after.
    const removeCheckout = (
      repo: string,
      worktreePath: string,
      force: boolean,
    ) =>
      Effect.gen(function* () {
        const admin = yield* git.adminDirOf(worktreePath);
        const removed = yield* git
          .removeWorktree({ repo, path: worktreePath, force })
          .pipe(Effect.result);
        if (Result.isSuccess(removed)) return;
        if (Option.isNone(admin) || !(yield* gone(admin.value))) {
          return yield* removed.failure;
        }
        yield* wipe(worktreePath).pipe(
          Effect.mapError(
            (error) =>
              new OrphanedWorktree({
                path: worktreePath,
                git:
                  removed.failure instanceof Git.GitCommandError
                    ? Git.stderrOf(removed.failure)
                    : removed.failure.message,
                wipe: error.message,
              }),
          ),
        );
      });

    // A managed checkout git still lists whose folder is there without
    // its `.git`: what a removal leaves when its git is killed mid-delete
    // (git deletes the folder first and its entry last), which git's
    // remove refuses, forced or not. Not a folder that is gone, as one on
    // a drive that isn't mounted is, nor a locked entry, which git keeps
    // after the wipe and refuses with its reason.
    const halfRemoved = Effect.fnUntraced(function* (
      worktree: WorktreeIdentity,
    ) {
      if (worktree.isExternal || worktree.locked) return false;
      const there = yield* fs
        .exists(worktree.path)
        .pipe(Effect.orElseSucceed(() => false));
      return there && (yield* gone(path.join(worktree.path, ".git")));
    });

    // What is left of a half-removed checkout, then git's entry, which a
    // remove of a path that is gone drops alone.
    const finishCheckout = (repo: string, worktreePath: string) =>
      wipe(worktreePath).pipe(
        Effect.andThen(
          git.removeWorktree({ repo, path: worktreePath, force: false }),
        ),
      );

    // Removes the folders a worktree leaves empty when they are ours.
    const pruneEmptyParents = (worktreePath: string, projectPath: string) =>
      Effect.gen(function* () {
        const parent = path.dirname(worktreePath);
        const place = {
          dataDir: paths.dataDir,
          canonicalDataDirName: paths.dataDirName,
        };
        // git spells the worktree's path with links resolved, and the
        // managed folder is named for the project as written, so each base
        // is compared both as written and resolved.
        const real = (at: string) =>
          fs.realPath(at).pipe(Effect.orElseSucceed(() => at));
        const projects = [projectPath, yield* real(projectPath)];
        const dataDirs = [place.dataDir, yield* real(place.dataDir)];
        const levels = Math.max(
          ...projects.flatMap((project) =>
            dataDirs.map((dataDir) =>
              ownedLevels(parent, project, { ...place, dataDir }),
            ),
          ),
        );
        // Each only when empty: something written there since keeps it.
        let dir = parent;
        for (let level = 0; level < levels; level++) {
          if (!(yield* removeEmptyFolder(dir))) return;
          dir = path.dirname(dir);
        }
      }).pipe(Effect.ignore);

    // A half-removed checkout is refused unforced, as one whose status
    // can't be read is: a `.git` deleted by mistake looks the same.
    const removable = Effect.fnUntraced(function* (
      worktree: WorktreeIdentity,
      force: boolean,
    ) {
      yield* notPrimary(worktree);
      if (!force && (yield* halfRemoved(worktree))) {
        return yield* new DirtyWorktree({
          reason: "half-removed",
          count: 0,
          verb: "remove",
          destroys: "",
        });
      }
      yield* requireClean(worktree, force, "remove", "");
    });

    const checkRemovable = Effect.fn("Worktrees.checkRemovable")(function* (
      located: Located,
      force: boolean,
    ) {
      yield* removable(located.worktree, force);
    });

    // Whether removing `worktree` deletes its branch: never an external
    // worktree's, a detached one's (it has none), one kept, or the
    // project's primary branch, else as the device's setting says.
    const deletesBranch = Effect.fn("Worktrees.deletesBranch")(function* (
      { project, worktree }: Located,
      keepBranch: boolean,
    ) {
      if (
        keepBranch ||
        worktree.isExternal ||
        worktree.detached ||
        worktree.branch === UNKNOWN_BRANCH ||
        !(yield* config.device("deleteBranchOnRemove"))
      ) {
        return false;
      }
      return worktree.branch !== (yield* primaryRefOf(project)).primaryBranch;
    });

    // Refused unless the worktree still holds `expect`: HEAD on its
    // branch, the branch at its tip and its uncommitted work the same
    // tree, read on this device as `expect` was. What can't be read is
    // no proof it does.
    const refuseChangedSince = Effect.fn("Worktrees.refuseChangedSince")(
      function* ({ project, worktree }: Located, expect: MovedSource) {
        const change = yield* Effect.gen(function* () {
          const head = yield* git
            .run(worktree.path, ["symbolic-ref", "--quiet", "HEAD"])
            .pipe(
              Effect.map((out) => out.trim()),
              Effect.orElseSucceed(() => null),
            );
          if (
            worktree.branch !== expect.branch ||
            head !== `refs/heads/${expect.branch}`
          ) {
            return "moved" as const;
          }
          const tip = yield* git.refTip(
            project.path,
            `refs/heads/${expect.branch}`,
          );
          const fresh = yield* dirty.capture({
            projectPath: project.path,
            worktreePath: worktree.path,
            worktreeId: worktree.id,
          });
          return movedSourceChange(expect, {
            tip: Option.getOrNull(tip),
            ...(fresh.captured
              ? { captureTree: yield* git.treeOf(project.path, fresh.commit) }
              : {}),
          });
        }).pipe(
          Effect.catchTags({
            NoHead: () => Effect.succeed("unread" as const),
            CaptureFailed: () => Effect.succeed("unread" as const),
          }),
        );
        if (change !== undefined) {
          return yield* new WorktreeRefused({
            reason: "changed-since-move",
            subject: worktree.path,
          });
        }
      },
    );

    const remove = Effect.fn("Worktrees.remove")(function* (
      located: Located,
      options: {
        readonly force: boolean;
        readonly keepBranch: boolean;
        readonly skipCleanup: boolean;
        readonly preflighted?: boolean;
        // A clock on each cleanup script: one that runs past it fails the
        // cleanup, as a script that failed does.
        readonly cleanupWithin?: Duration.Input;
        // A transplant's teardown or a mirror's other side: what the
        // worktree must still hold at the delete.
        readonly expect?: MovedSource;
      },
      reporter: Reporter,
    ) {
      const { project, worktree } = located;
      yield* options.preflighted
        ? notPrimary(worktree)
        : removable(worktree, options.force);
      // A half-removed checkout's cleanup ran before the delete that was
      // cut short.
      const half = yield* halfRemoved(worktree);
      const deletingBranch = yield* deletesBranch(located, options.keepBranch);
      // The worktree's mirror stops first, before the cleanup, so nothing
      // a cleanup script writes crosses to the other device, and is told
      // once the removal is done how it ended: the files gone once git's
      // side went, whatever follows, kept by git's step, or never that
      // far.
      let end: DeleteEnd = "short";
      yield* Effect.acquireRelease(
        stopMirrors(project.id, worktree),
        (stopped) => Effect.suspend(() => stopped(end)),
      );
      // Never for an external worktree: no provision ever ran.
      let cleanupRan = false;
      if (!worktree.isExternal && !options.skipCleanup && !half) {
        const { settings } = yield* projectSettings(project);
        const teardown = lifecycleCommand(
          { kind: "teardown" },
          settings,
          worktree.path,
        );
        const pool = yield* portPoolActive(worktree);
        if (pool || teardown !== "") {
          const context = yield* scriptContextOf(project, worktree);
          const cleanup = (
            phase: CleanupFailed["phase"],
            command: string,
            slot: LifecycleSlot,
          ) => {
            // The run a clock stops is named by the run it started.
            let started = "";
            const watched: Reporter = {
              ...reporter,
              report: (event) => {
                if (event.event === "script" && event.kind === "started") {
                  started = event.runId;
                }
                return reporter.report(event);
              },
            };
            return runScript(context, watched, command, slot).pipe(
              Effect.flatMap(({ code, runId }) =>
                code === 0
                  ? Effect.void
                  : Effect.fail(
                      new CleanupFailed({ phase, exitCode: code, runId }),
                    ),
              ),
              (run) =>
                options.cleanupWithin === undefined
                  ? run
                  : run.pipe(
                      Effect.timeoutOrElse({
                        duration: options.cleanupWithin,
                        orElse: () =>
                          Effect.fail(
                            new CleanupFailed({
                              phase,
                              exitCode: null,
                              runId: started,
                            }),
                          ),
                      }),
                    ),
            );
          };
          cleanupRan = true;
          if (pool) {
            const slot = { kind: "portPool", phase: "release" } as const;
            yield* cleanup(
              "portPoolRelease",
              lifecycleCommand(slot, settings, worktree.path),
              slot,
            );
          }
          if (teardown !== "") {
            yield* cleanup("teardown", teardown, { kind: "teardown" });
          }
        }
      }
      // Asked again after the cleanup (the app asks before it stops any
      // script), right before the delete: a cleanup script or an editor
      // can write to the worktree meanwhile, and a forced delete has no
      // check of git's to stop it.
      if (options.expect !== undefined) {
        yield* refuseChangedSince(located, options.expect);
      }
      // Unforced, git checks the tree again at the delete, which covers
      // what a cleanup script wrote since `removable`'s check. Once git's
      // side is done (an orphaned checkout's too), the rest goes before
      // anything can cut in: what is kept under the id, which a worktree
      // made at the same path later would take over, and the branch, which
      // nothing would remove after an interrupt (a Ctrl-C, a quit). What
      // the app runs in it lets go first.
      const removed = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* releaseHolders(project.id, worktree);
          end = "kept";
          const checkout: Effect.Effect<
            void,
            Git.GitError | OrphanedWorktree | PlatformError.PlatformError
          > = half
            ? finishCheckout(project.path, worktree.path)
            : removeCheckout(project.path, worktree.path, options.force);
          const outcome = yield* Effect.result(checkout);
          if (
            Result.isFailure(outcome) &&
            !(outcome.failure instanceof OrphanedWorktree)
          ) {
            return outcome;
          }
          end = "gone";
          yield* kept.forget(project, worktree.id);
          if (!worktree.isExternal) {
            yield* pruneEmptyParents(worktree.path, project.path);
          }
          if (deletingBranch) {
            // The branch may be shared, or the primary's: a failure is fine.
            yield* git
              .run(project.path, ["branch", "-D", "--", worktree.branch])
              .pipe(Effect.ignore);
          }
          return outcome;
        }),
      );
      if (
        Result.isFailure(removed) &&
        !(removed.failure instanceof OrphanedWorktree)
      ) {
        const failure = removed.failure;
        if (
          !options.force &&
          failure instanceof Git.GitCommandError &&
          Git.stderrOf(failure).includes("contains modified or untracked files")
        ) {
          return yield* new WorktreeRefused({
            reason: cleanupRan
              ? "changed-during-cleanup"
              : "uncommitted-at-remove",
            subject: worktree.path,
          });
        }
        return yield* failure;
      }
      if (Result.isFailure(removed)) return yield* removed.failure;
      return {
        id: worktree.id,
        name: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        projectName: project.name,
      };
    }, Effect.scoped);
    return {
      requireClean,
      wipe,
      removeCheckout,
      pruneEmptyParents,
      removable,
      checkRemovable,
      deletesBranch,
      refuseChangedSince,
      remove,
    };
  });

export type RemovingArea = Effect.Success<ReturnType<typeof makeRemoving>>;
