// Worktrees' removing: the guards a removal passes, the teardown, and
// the checkout and branch going.
import type { LifecycleSlot } from "@shigomori/contracts/schemas/scripts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Config from "../Config.ts";
import * as Git from "../Git.ts";
import { shellQuote } from "../Lifecycle.ts";
import * as Paths from "../Paths.ts";
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
  scriptOf,
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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = yield* Config.Config;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const { projectSettings } = listing;
    const { scriptContext, runScript, portPoolActive } = creating;

    // Fails closed on a dirty or unreadable worktree, untracked files
    // counted whatever the user's setting, since the next step destroys
    // the folder.
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
    // writer that defeated git's sweep may still be landing files.
    const wipe = (dir: string) =>
      fs.remove(dir, { recursive: true, force: true }).pipe(
        Effect.retry({
          while: (error) =>
            Predicate.hasProperty(error.cause, "code") &&
            error.cause.code === "ENOTEMPTY",
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

    // Removes the folders a worktree leaves empty when they are ours.
    const pruneEmptyParents = (worktreePath: string, projectPath: string) =>
      Effect.gen(function* () {
        const parent = path.dirname(worktreePath);
        const place = {
          dataDir: paths.dataDir,
          dataDirName: paths.dataDirName,
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
        // rmdir, which takes only an empty folder: something written there
        // since keeps it.
        let dir = parent;
        for (let level = 0; level < levels; level++) {
          const code = yield* spawner.exitCode(
            ChildProcess.make("rmdir", [dir]),
          );
          if (code !== 0) return;
          dir = path.dirname(dir);
        }
      }).pipe(Effect.ignore);

    const removable = (worktree: WorktreeIdentity, force: boolean) =>
      notPrimary(worktree).pipe(
        Effect.andThen(requireClean(worktree, force, "remove", "")),
      );

    // Whether removing `worktree` deletes its branch: never an external
    // worktree's, a detached one's (it has none), or one kept, else as the
    // device's setting says.
    const deletesBranch = Effect.fn("Worktrees.deletesBranch")(function* (
      worktree: WorktreeIdentity,
      keepBranch: boolean,
    ) {
      if (
        keepBranch ||
        worktree.isExternal ||
        worktree.detached ||
        worktree.branch === UNKNOWN_BRANCH
      ) {
        return false;
      }
      return yield* config.device("deleteBranchOnRemove");
    });

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
      },
      reporter: Reporter,
    ) {
      const { project, worktree } = located;
      yield* options.preflighted
        ? notPrimary(worktree)
        : removable(worktree, options.force);
      const deletingBranch = yield* deletesBranch(worktree, options.keepBranch);
      // Never for an external worktree: no provision ever ran.
      let cleanupRan = false;
      if (!worktree.isExternal && !options.skipCleanup) {
        const { settings } = yield* projectSettings(project);
        const teardown = scriptOf(settings, "teardown");
        const pool = yield* portPoolActive(worktree);
        if (pool || teardown !== "") {
          const context = yield* scriptContext(project, worktree);
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
            yield* cleanup(
              "portPoolRelease",
              `port-pool release ${shellQuote(worktree.path)}`,
              { kind: "portPool", phase: "release" },
            );
          }
          if (teardown !== "") {
            yield* cleanup("teardown", teardown, { kind: "teardown" });
          }
        }
      }
      // Unforced, git checks the tree again at the delete, which covers
      // what a cleanup script wrote since the check above. Once git's
      // side is done (an orphaned checkout's too), what is kept under the
      // id goes before anything can cut in: a worktree made at the same
      // path later would take it over.
      const removed = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const outcome = yield* removeCheckout(
            project.path,
            worktree.path,
            options.force,
          ).pipe(Effect.result);
          if (
            Result.isSuccess(outcome) ||
            outcome.failure instanceof OrphanedWorktree
          ) {
            yield* kept.forget(project, worktree.id);
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
      if (!worktree.isExternal) {
        yield* pruneEmptyParents(worktree.path, project.path);
      }
      if (deletingBranch) {
        // The branch may be shared, or the primary's: a failure is fine.
        yield* git
          .run(project.path, ["branch", "-D", "--", worktree.branch])
          .pipe(Effect.ignore);
      }
      if (Result.isFailure(removed)) return yield* removed.failure;
      return {
        id: worktree.id,
        name: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        projectName: project.name,
      };
    });
    return {
      requireClean,
      wipe,
      removeCheckout,
      pruneEmptyParents,
      removable,
      deletesBranch,
      remove,
    };
  });

export type RemovingArea = Effect.Success<ReturnType<typeof makeRemoving>>;
