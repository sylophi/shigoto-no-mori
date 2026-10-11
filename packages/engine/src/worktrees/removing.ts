// Worktrees' removing: the guards a removal passes, the teardown, and
// the checkout and branch going.
import type { LifecycleSlot } from "@shigomori/contracts/schemas/scripts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as CloneCheckout from "../CloneCheckout.ts";
import * as Config from "../Config.ts";
import { dirtyRef } from "../Dirty.ts";
import * as Git from "../Git.ts";
import { shellQuote } from "../Lifecycle.ts";
import * as Paths from "../Paths.ts";
import { isNotFound } from "../platformErrors.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as WorktreeData from "../WorktreeData.ts";
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
}: {
  readonly listing: ListingArea;
  readonly creating: CreatingArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const cloneCheckout = yield* CloneCheckout.CloneCheckout;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = yield* Config.Config;
    const registry = yield* Registry.Registry;
    const data = yield* WorktreeData.WorktreeData;
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
          schedule: Schedule.spaced("250 millis").pipe(
            Schedule.upTo({ duration: "5 seconds" }),
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
        const levels = ownedLevels(parent, projectPath, {
          dataDir: paths.dataDir,
          dataDirName: paths.dataDirName,
        });
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

    // What is kept under an id that is going away: marks, the shelf, the
    // title, and a pending dirty capture.
    const forget = (project: RegisteredProject, worktreeId: string) =>
      Effect.all([
        registry.forgetWorktree(worktreeId),
        data.forget(project.id, worktreeId),
        git.deleteRef(project.path, dirtyRef(worktreeId)).pipe(Effect.ignore),
        // What clones proved about its files, as a source.
        cloneCheckout.forget(worktreeId),
      ]);

    // What is kept under one id, carried to another.
    const rekeyWorktree = (
      project: RegisteredProject,
      from: string,
      to: string,
    ) =>
      Effect.gen(function* () {
        yield* registry.moveWorktree(from, to);
        yield* data.move(project.id, from, to);
        // A pending capture belongs to the worktree, not its old path.
        const capture = yield* git.refTip(project.path, dirtyRef(from));
        if (Option.isSome(capture)) {
          yield* git
            .updateRef({
              repo: project.path,
              ref: dirtyRef(to),
              commit: capture.value,
            })
            .pipe(
              Effect.andThen(git.deleteRef(project.path, dirtyRef(from))),
              Effect.ignore,
            );
        }
      });

    const removable = (worktree: WorktreeIdentity, force: boolean) =>
      notPrimary(worktree).pipe(
        Effect.andThen(requireClean(worktree, force, "remove", "")),
      );

    const remove = Effect.fn("Worktrees.remove")(function* (
      located: Located,
      options: {
        readonly force: boolean;
        readonly keepBranch: boolean;
        readonly skipCleanup: boolean;
        readonly preflighted?: boolean;
      },
      reporter: Reporter,
    ) {
      const { project, worktree } = located;
      yield* options.preflighted
        ? notPrimary(worktree)
        : removable(worktree, options.force);
      const deleteBranchOnRemove = (yield* config
        .get({ kind: "device" }, "deleteBranchOnRemove")
        .pipe(Effect.orDie)).value;
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
          ) =>
            runScript(context, reporter, command, slot).pipe(
              Effect.flatMap(({ code, runId }) =>
                code === 0
                  ? Effect.void
                  : Effect.fail(
                      new CleanupFailed({ phase, exitCode: code, runId }),
                    ),
              ),
            );
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
      // what a cleanup script wrote since the check above.
      const removed = yield* removeCheckout(
        project.path,
        worktree.path,
        options.force,
      ).pipe(Effect.result);
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
      // An orphaned checkout is git's side done, so the bookkeeping still
      // follows it.
      if (!worktree.isExternal) {
        yield* pruneEmptyParents(worktree.path, project.path);
      }
      yield* forget(project, worktree.id);
      if (
        !options.keepBranch &&
        deleteBranchOnRemove !== false &&
        !worktree.isExternal &&
        worktree.branch !== UNKNOWN_BRANCH
      ) {
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
      rekeyWorktree,
      removable,
      remove,
    };
  });

export type RemovingArea = Effect.Success<ReturnType<typeof makeRemoving>>;
