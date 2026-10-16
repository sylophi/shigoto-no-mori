// Worktrees' moving: a worktree to another folder or name, across
// volumes too, and what is kept under its id carried along.
//
// A move is recorded in `moving` before anything moves
// (migrations/moving.ts). git's move is its commit point: from there the
// carry runs uninterrupted and deletes the record in the transaction that
// re-keys what is kept under the id, and a move a crash cut short is
// finished or undone by `resume` (at the app's start and by the doctor's
// fix), by where git lists the checkout.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { findExecutable } from "../executables.ts";
import * as Git from "../Git.ts";
import { copyTree } from "../entries.ts";
import { startOf, stillRunning } from "../processes.ts";
import * as Registry from "../Registry.ts";
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
import type { KeptArea } from "./kept.ts";
import type { RemovingArea } from "./removing.ts";

type MovingRow = {
  readonly from_path: string;
  readonly to_path: string;
  readonly project_id: string;
  readonly partial: string | null;
  readonly pid: number;
  readonly started_at: number;
};

export const makeMoving = ({
  listing,
  creating,
  removing,
  kept,
}: {
  readonly listing: ListingArea;
  readonly creating: CreatingArea;
  readonly removing: RemovingArea;
  readonly kept: KeptArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registry = yield* Registry.Registry;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const { deviceFlag, identities, row } = listing;
    const { checkName, occupied, portPoolActive } = creating;
    const { wipe, pruneEmptyParents } = removing;

    const withSpawner = Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      spawner,
    );
    const running = (record: MovingRow) =>
      withSpawner(stillRunning(record.pid, record.started_at));

    // This process as a move's record names it, read once.
    const self = yield* Effect.cached(
      Effect.map(withSpawner(startOf(process.pid)), (started) => ({
        pid: process.pid,
        started_at: Option.getOrElse(started, () => Date.now()),
      })),
    );

    // The record of a move about to start. Another process's move of the
    // same folder holds it while that process runs; one whose process is
    // gone is resumed first.
    const claimMove = (project: RegisteredProject, from: string, to: string) =>
      Effect.gen(function* () {
        const claim = Effect.gen(function* () {
          return (
            (yield* sql`INSERT INTO moving ${sql.insert({
              from_path: from,
              to_path: to,
              project_id: project.id,
              partial: null,
              ...(yield* self),
            })} ON CONFLICT DO NOTHING RETURNING from_path`.pipe(Effect.orDie))
              .length > 0
          );
        });
        if (yield* claim) return;
        const [held] = yield* sql<MovingRow>`
          SELECT from_path, to_path, project_id, partial, pid, started_at
          FROM moving WHERE from_path = ${from}`.pipe(Effect.orDie);
        if (held !== undefined) yield* resumeOne(held);
        if (!(yield* claim)) {
          return yield* new WorktreeRefused({
            reason: "move-in-progress",
            subject: from,
          });
        }
      });

    const forgetRecord = (from: string) =>
      sql`DELETE FROM moving WHERE from_path = ${from}`.pipe(Effect.orDie);

    // The move git can't make, across volumes: the checkout copied into a
    // sibling of `to` and renamed in once whole, git pointed at it, and the
    // original gone only once git lists the worktree at its new path. A
    // failure or an interrupt before that leaves the original as it was.
    // Only the copy may be interrupted (`restore`).
    const moveAcrossVolumes = (
      project: RegisteredProject,
      from: string,
      to: string,
      restore: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const partial = path.join(
          path.dirname(to),
          `.${path.basename(to)}.partial-${(yield* Random.nextInt).toString(36)}`,
        );
        yield* sql`UPDATE moving SET partial = ${partial}
          WHERE from_path = ${from}`.pipe(Effect.orDie);
        const undo = wipe(partial).pipe(
          Effect.andThen(wipe(to)),
          Effect.andThen(
            git.run(project.path, ["worktree", "repair", "--", from]),
          ),
          Effect.ignore,
        );
        const cp = (flags: ReadonlyArray<string>) =>
          copyTree(spawner, from, partial, flags);
        // -p keeps the times and modes. A volume that can't hold some of
        // them fails it, so the plain copy is the second try.
        const copied = yield* restore(
          cp(["-p"]).pipe(
            Effect.catch(() => wipe(partial).pipe(Effect.andThen(cp([])))),
          ),
        ).pipe(
          Effect.onInterrupt(() => undo),
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
        const repaired = yield* fs
          .rename(partial, to)
          .pipe(
            Effect.orDie,
            Effect.andThen(
              git.run(project.path, ["worktree", "repair", "--", to]),
            ),
            Effect.andThen(findMoved(project, to)),
            Effect.result,
          );
        if (Result.isFailure(repaired)) {
          yield* undo;
          return yield* repaired.failure;
        }
      });

    // The worktree git lists at `to`, in git's spelling (a symlinked
    // parent resolved), which the new id derives from.
    const listedAt = (project: RegisteredProject, at: string) =>
      Effect.gen(function* () {
        const resolved = yield* fs
          .realPath(at)
          .pipe(Effect.orElseSucceed(() => ""));
        return (yield* identities(project)).find(
          (id) => id.path === at || (resolved !== "" && id.path === resolved),
        );
      });

    const findMoved = (project: RegisteredProject, to: string) =>
      Effect.flatMap(listedAt(project, to), (moved) =>
        moved === undefined
          ? Effect.fail(
              new WorktreeRefused({ reason: "move-not-listed", subject: to }),
            )
          : Effect.succeed(moved),
      );

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
      if (to === worktree.path) {
        return {
          worktree: yield* carryMoved(project, worktree.path, to),
          previousId: worktree.id,
        };
      }
      // git would move the checkout into an existing folder, at a path
      // (and an id) other than the one asked for.
      if (yield* occupied(to)) {
        return yield* new WorktreeRefused({
          reason: "move-destination-exists",
          subject: to,
        });
      }
      // Recorded inside the region, so no interrupt can leave the record
      // with nothing under way.
      let crossed = false;
      const carried = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* claimMove(project, worktree.path, to);
          yield* fs
            .makeDirectory(path.dirname(to), { recursive: true })
            .pipe(Effect.orDie);
          const moved = yield* git
            .run(project.path, ["worktree", "move", "--", worktree.path, to])
            .pipe(
              Effect.asVoid,
              Effect.catchTags({
                GitCommandError: (error) =>
                  Git.stderrOf(error)
                    .toLowerCase()
                    .includes("cross-device link")
                    ? Effect.suspend(() => {
                        crossed = true;
                        return moveAcrossVolumes(
                          project,
                          worktree.path,
                          to,
                          restore,
                        );
                      })
                    : Effect.fail(error),
              }),
              Effect.result,
            );
          if (Result.isFailure(moved)) {
            yield* forgetRecord(worktree.path);
            // The folders made for it go again when they are ours and empty.
            yield* pruneEmptyParents(to, project.path);
            return yield* moved.failure;
          }
          const landed = yield* carryMoved(project, worktree.path, to);
          // The original a copy across volumes leaves, once git lists the
          // copy: a stray folder, not a failed move.
          if (crossed) yield* wipe(worktree.path).pipe(Effect.ignore);
          return landed;
        }),
      );
      yield* pruneEmptyParents(worktree.path, project.path);
      return { worktree: carried, previousId: worktree.id };
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

    // The move's commit: what is kept under the old id re-keyed, the move
    // recorded as made and its record of being under way deleted, in one
    // transaction.
    const carryMoved = Effect.fn("Worktrees.carryMoved")(function* (
      project: RegisteredProject,
      fromPath: string,
      toPath: string,
    ) {
      const moved = yield* findMoved(project, toPath);
      const from = worktreeIdFromPath(fromPath);
      if (moved.id !== from) {
        yield* sql
          .withTransaction(
            Effect.all([
              kept.rekeyRows(project, from, moved.id),
              sql`INSERT INTO wt_moves ${sql.insert({
                from_path: fromPath,
                to_path: moved.path,
                project_id: project.id,
                moved: 1,
              })} ON CONFLICT (from_path) DO UPDATE SET
                to_path = excluded.to_path, moved = 1, error = NULL`,
              forgetRecord(fromPath),
            ]),
          )
          .pipe(Effect.orDie);
        yield* kept.rekeyCapture(project, from, moved.id);
        yield* carryLease(fromPath, moved);
      } else {
        yield* forgetRecord(fromPath);
      }
      return yield* row({ project, worktree: moved });
    });

    // One recorded move whose process is gone, by where git lists the
    // checkout: at its destination it is finished (the carry, then the
    // original a copy left), elsewhere undone (the partial copy, or the
    // whole one a crash left before git was pointed at it).
    const resumeOne = (record: MovingRow) =>
      Effect.gen(function* () {
        if (yield* running(record)) return;
        const project = (yield* registry.listed).find(
          ({ id }) => id === record.project_id,
        );
        if (project === undefined) return yield* forgetRecord(record.from_path);
        const landed = yield* listedAt(project, record.to_path);
        if (landed !== undefined) {
          yield* carryMoved(project, record.from_path, record.to_path);
          if ((yield* listedAt(project, record.from_path)) === undefined) {
            yield* wipe(record.from_path).pipe(Effect.ignore);
          }
          if (record.partial !== null) {
            yield* wipe(record.partial).pipe(Effect.ignore);
          }
          return yield* pruneEmptyParents(record.from_path, project.path);
        }
        if (record.partial !== null) {
          yield* wipe(record.partial).pipe(Effect.ignore);
          if ((yield* listedAt(project, record.from_path)) !== undefined) {
            yield* wipe(record.to_path).pipe(Effect.ignore);
          }
        }
        yield* forgetRecord(record.from_path);
        yield* pruneEmptyParents(record.to_path, project.path);
      }).pipe(
        // A repo that can't be read now keeps its record for the next try.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(
                "Couldn't finish an interrupted move",
                cause,
              ).pipe(
                Effect.annotateLogs({
                  from: record.from_path,
                  to: record.to_path,
                }),
              ),
        ),
      );

    const resume = Effect.gen(function* () {
      const records = yield* sql<MovingRow>`
        SELECT from_path, to_path, project_id, partial, pid, started_at
        FROM moving`.pipe(Effect.orDie);
      for (const record of records) yield* resumeOne(record);
    }).pipe(Effect.withSpan("Worktrees.resumeMoves"));

    const interrupted = sql<MovingRow>`
      SELECT from_path, to_path, project_id, partial, pid, started_at
      FROM moving`.pipe(
      Effect.flatMap((records) =>
        Effect.filter(records, (record) =>
          Effect.map(running(record), (live) => !live),
        ),
      ),
      Effect.map((records) =>
        records.map((record) => ({
          fromPath: record.from_path,
          toPath: record.to_path,
          projectId: record.project_id,
        })),
      ),
      Effect.orDie,
    );

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
      if (to !== from) yield* kept.rekey(project, from, to);
      return to;
    });
    return { move, carryMoved, rename, rekey, resume, interrupted };
  });

export type MovingArea = Effect.Success<ReturnType<typeof makeMoving>>;
