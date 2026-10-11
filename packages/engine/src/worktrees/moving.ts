// Worktrees' moving: a worktree to another folder or name, across
// volumes too, and what is kept under its id carried along.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { findExecutable } from "../executables.ts";
import * as Git from "../Git.ts";
import { copyTree } from "../entries.ts";
import type { RegisteredProject } from "../Registry.ts";
import { cleanPath, worktreeIdFromPath } from "../worktreeLayout.ts";
import {
  type Located,
  UnknownWorktree,
  type WorktreeIdentity,
  WorktreeRefused,
} from "./documents.ts";
import type { ListingArea } from "./listing.ts";
import type { CreatingArea } from "./creating.ts";
import type { RemovingArea } from "./removing.ts";

export const makeMoving = ({
  listing,
  creating,
  removing,
}: {
  readonly listing: ListingArea;
  readonly creating: CreatingArea;
  readonly removing: RemovingArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const { deviceFlag, identities, row } = listing;
    const { checkName, occupied, portPoolActive } = creating;
    const { wipe, pruneEmptyParents, rekeyWorktree } = removing;

    // The move git can't make, across volumes: the checkout copied over,
    // git pointed at the copy, and the original gone only once git lists
    // the worktree at its new path. A failure before that leaves the
    // original as it was.
    const moveAcrossVolumes = (
      project: RegisteredProject,
      from: string,
      to: string,
    ) =>
      Effect.gen(function* () {
        const undo = wipe(to).pipe(
          Effect.andThen(
            git.run(project.path, ["worktree", "repair", "--", from]),
          ),
          Effect.ignore,
        );
        const cp = (flags: ReadonlyArray<string>) =>
          copyTree(spawner, from, to, flags);
        // -p keeps the times and modes. A volume that can't hold some of
        // them fails it, so the plain copy is the second try.
        const copied = yield* cp(["-p"]).pipe(
          Effect.catch(() => wipe(to).pipe(Effect.andThen(cp([])))),
          Effect.result,
        );
        if (Result.isFailure(copied)) {
          yield* undo;
          return yield* new WorktreeRefused({
            reason: "move-copy-failed",
            subject: to,
            cause: copied.failure.cause,
          });
        }
        const repaired = yield* git
          .run(project.path, ["worktree", "repair", "--", to])
          .pipe(Effect.andThen(findMoved(project, to)), Effect.result);
        if (Result.isFailure(repaired)) {
          yield* undo;
          return yield* repaired.failure;
        }
        // A leftover original is a stray folder, not a failed move.
        yield* wipe(from).pipe(Effect.ignore);
      });

    // The worktree git lists at `to`, in git's spelling (a symlinked
    // parent resolved), which the new id derives from.
    const findMoved = (project: RegisteredProject, to: string) =>
      Effect.gen(function* () {
        const resolved = yield* fs
          .realPath(to)
          .pipe(Effect.orElseSucceed(() => ""));
        const moved = (yield* identities(project)).find(
          (id) => id.path === to || (resolved !== "" && id.path === resolved),
        );
        if (!moved) {
          return yield* new WorktreeRefused({
            reason: "move-not-listed",
            subject: to,
          });
        }
        return moved;
      });

    const move = Effect.fn("Worktrees.move")(function* (
      located: Located,
      target: string,
    ) {
      const { project, worktree } = located;
      if (worktree.isPrimary) {
        return yield* new WorktreeRefused({
          reason: "move-primary",
          subject: "",
        });
      }
      const to = cleanPath(target);
      if (to !== worktree.path) {
        // git would move the checkout into an existing folder, at a path
        // (and an id) other than the one asked for.
        if (yield* occupied(to)) {
          return yield* new WorktreeRefused({
            reason: "move-destination-exists",
            subject: to,
          });
        }
        yield* fs
          .makeDirectory(path.dirname(to), { recursive: true })
          .pipe(Effect.orDie);
        const moved = yield* git
          .run(project.path, ["worktree", "move", "--", worktree.path, to])
          .pipe(
            Effect.catchTags({
              GitCommandError: (error) =>
                Git.stderrOf(error).toLowerCase().includes("cross-device link")
                  ? moveAcrossVolumes(project, worktree.path, to)
                  : Effect.fail(error),
            }),
            Effect.result,
          );
        if (Result.isFailure(moved)) {
          // The folders made for it go again when they are ours and empty.
          yield* pruneEmptyParents(to, project.path);
          return yield* moved.failure;
        }
        yield* pruneEmptyParents(worktree.path, project.path);
      }
      return {
        worktree: yield* carryMoved(project, worktree.path, to),
        previousId: worktree.id,
      };
    });

    // port-pool keys a lease by its folder: the old folder's goes, and a
    // managed checkout gets its own on the new one, where the ports may
    // differ. A failure is only logged.
    const carryLease = (fromPath: string, moved: WorktreeIdentity) =>
      Effect.gen(function* () {
        if (!(yield* deviceFlag("portPool"))) return;
        const installed = yield* findExecutable("port-pool").pipe(
          Effect.provideContext(platform),
        );
        if (Option.isNone(installed)) return;
        const steps = [["release", fromPath]];
        if (yield* portPoolActive(moved)) steps.push(["ensure", moved.path]);
        for (const args of steps) {
          const code = yield* spawner.exitCode(
            ChildProcess.make("port-pool", args),
          );
          if (code !== 0) {
            yield* Effect.logWarning("port-pool failed after a move").pipe(
              Effect.annotateLogs({ args: args.join(" "), code }),
            );
          }
        }
      }).pipe(Effect.ignore);

    const carryMoved = Effect.fn("Worktrees.carryMoved")(function* (
      project: RegisteredProject,
      fromPath: string,
      toPath: string,
    ) {
      const moved = yield* findMoved(project, toPath);
      const from = worktreeIdFromPath(fromPath);
      if (moved.id !== from) {
        yield* rekeyWorktree(project, from, moved.id);
        yield* carryLease(fromPath, moved);
        yield* sql`INSERT INTO wt_moves ${sql.insert({
          from_path: fromPath,
          to_path: moved.path,
          project_id: project.id,
          moved: 1,
        })} ON CONFLICT (from_path) DO UPDATE SET
          to_path = excluded.to_path, moved = 1, error = NULL`.pipe(
          Effect.orDie,
        );
      }
      return yield* row({ project, worktree: moved });
    });

    const rename = Effect.fn("Worktrees.rename")(function* (
      project: RegisteredProject,
      worktreeId: string,
      requested: string,
    ) {
      const found = yield* identities(project);
      const worktree = found.find(({ id }) => id === worktreeId);
      if (worktree === undefined)
        return yield* new UnknownWorktree({ worktreeId });
      if (worktree.isPrimary) {
        return yield* new WorktreeRefused({
          reason: "rename-primary",
          subject: "",
        });
      }
      const name = requested.trim();
      if (name === "") {
        return yield* new WorktreeRefused({
          reason: "invalid-name",
          subject: name,
        });
      }
      yield* checkName(name);
      if (name === path.basename(worktree.path)) {
        return {
          worktree: yield* row({ project, worktree }),
          previousId: worktree.id,
        };
      }
      if (
        found.some(
          (other) =>
            other.id !== worktree.id &&
            path.basename(other.path).toLowerCase() === name.toLowerCase(),
        )
      ) {
        return yield* new WorktreeRefused({
          reason: "name-taken",
          subject: name,
        });
      }
      return yield* move(
        { project, worktree },
        path.join(path.dirname(worktree.path), name),
      );
    });

    const rekey = Effect.fn("Worktrees.rekey")(function* (
      project: RegisteredProject,
      from: string,
      toPath: string,
    ) {
      const to = worktreeIdFromPath(cleanPath(toPath));
      if (to !== from) yield* rekeyWorktree(project, from, to);
      return to;
    });
    return { move, carryMoved, rename, rekey };
  });

export type MovingArea = Effect.Success<ReturnType<typeof makeMoving>>;
