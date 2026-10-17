// Worktrees' moving: a worktree to another folder or name, across
// volumes too, and what is kept under its id carried along.
//
// A move is recorded in `moving` before anything moves
// (migrations/moving.ts), and git's move is its commit point. From the
// record to the carry nothing interrupts it; the record goes once the
// carry is whole, and a move a crash cut short is finished or undone by
// `resume` (at the app's start and by the doctor's fix).
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
import { startOf, stillRunning, UNKNOWN_BIRTH } from "../processes.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import {
  cleanPath,
  stagingName,
  worktreeIdFromPath,
} from "../worktreeLayout.ts";
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
  readonly link: string;
  readonly carried: number;
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
    // This process as a move's record names it, read once it could be:
    // a ps that failed is asked again at the next move, so one slow ps
    // doesn't leave this process's records unknown for its life.
    let known: { readonly pid: number; readonly started_at: number } | null =
      null;
    const self = Effect.suspend(() =>
      known !== null
        ? Effect.succeed(known)
        : Effect.map(withSpawner(startOf(process.pid)), (started) => {
            const owner = {
              pid: process.pid,
              started_at: Option.getOrElse(started, () => UNKNOWN_BIRTH),
            };
            if (Option.isSome(started)) known = owner;
            return owner;
          }),
    );
    // The folders this process is moving or resuming: a record it holds
    // is live only while one of them is under way, so one a defect left
    // is resumed like a dead process's.
    const underWay = new Set<string>();
    const live = (record: MovingRow) =>
      Effect.gen(function* () {
        const owner = yield* self;
        return record.pid === owner.pid &&
          record.started_at === owner.started_at
          ? underWay.has(record.from_path)
          : yield* withSpawner(stillRunning(record.pid, record.started_at));
      });

    // The record of a move about to start, refused while another move
    // under way names either folder: its carry may still be owed what is
    // kept under their ids. One whose process is gone is resumed first.
    const claimMove = (project: RegisteredProject, from: string, to: string) =>
      Effect.gen(function* () {
        const others = sql<MovingRow>`SELECT * FROM moving
          WHERE from_path IN (${from}, ${to}) OR to_path IN (${from}, ${to})`;
        const claim = sql.withTransaction(
          Effect.gen(function* () {
            // The write lock first, so no other claim reads between.
            yield* sql`UPDATE moving SET pid = pid WHERE 0`;
            if ((yield* others).length > 0) return false;
            yield* sql`INSERT INTO moving ${sql.insert({
              from_path: from,
              to_path: to,
              project_id: project.id,
              link: yield* linkOf(from),
              partial: null,
              ...(yield* self),
            })}`;
            return true;
          }),
        );
        if (yield* claim.pipe(Effect.orDie)) return;
        for (const held of yield* others.pipe(Effect.orDie)) {
          yield* resumeOne(held);
        }
        if (!(yield* claim.pipe(Effect.orDie))) {
          return yield* new WorktreeRefused({
            reason: "move-in-progress",
            subject: from,
          });
        }
      });

    // Deleted only by its holder: another start may have taken it over.
    const forgetRecord = (from: string) =>
      Effect.flatMap(
        self,
        (owner) => sql`DELETE FROM moving WHERE from_path = ${from}
          AND pid = ${owner.pid} AND started_at = ${owner.started_at}`,
      ).pipe(Effect.orDie);

    // A dead holder's record taken over, by one process alone.
    const takeOver = (record: MovingRow) =>
      Effect.gen(function* () {
        const owner = yield* self;
        const taken = yield* sql`UPDATE moving
          SET pid = ${owner.pid}, started_at = ${owner.started_at}
          WHERE from_path = ${record.from_path} AND pid = ${record.pid}
            AND started_at = ${record.started_at}
          RETURNING from_path`;
        return taken.length > 0;
      }).pipe(Effect.orDie);

    // The entry of git's a checkout belongs to (the admin folder its
    // `.git` file names, resolved, as git may write it relative), which
    // git's move keeps and a copy repeats: what tells the move's own
    // checkout, or a copy of it, from another folder at the same path.
    // Empty when there is none to read.
    // `from` is where the file was written, for one a rename carried
    // before git could write it again.
    const linkOf = (dir: string, from = dir) =>
      Effect.gen(function* () {
        const text = yield* fs.readFileString(path.join(dir, ".git"));
        const named = text.trim().replace(/^gitdir:\s*/, "");
        return yield* fs.realPath(path.resolve(from, named));
      }).pipe(Effect.orElseSucceed(() => ""));
    // The checkout gone from `from` and at `to`, holding `link`: git's
    // rename made, whatever git said after it.
    const movedOnDisk = (from: string, to: string, link: string) =>
      Effect.gen(function* () {
        const gone = !(yield* fs
          .exists(from)
          .pipe(Effect.orElseSucceed(() => true)));
        return (
          gone &&
          link !== "" &&
          ((yield* holdsLink(to, link)) || (yield* linkOf(to, from)) === link)
        );
      });

    // git pointed at a checkout it renamed but couldn't record, and
    // whether it now lists it there.
    const relinked = (project: RegisteredProject, to: string) =>
      git.run(project.path, ["worktree", "repair", "--", to]).pipe(
        Effect.andThen(listedAt(project, to)),
        Effect.map((found) => found !== undefined),
        Effect.orElseSucceed(() => false),
      );

    // A copy's `.git` file as copied, which a relative link resolves
    // wrongly from until git is pointed at it.
    const sameGitFile = (copy: string, of: string) =>
      Effect.gen(function* () {
        const read = (dir: string) =>
          fs
            .readFileString(path.join(dir, ".git"))
            .pipe(Effect.orElseSucceed(() => ""));
        const [a, b] = [yield* read(copy), yield* read(of)];
        return a !== "" && a === b;
      });
    const holdsLink = (dir: string, link: string) =>
      Effect.map(linkOf(dir), (found) => link !== "" && found === link);

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
          stagingName(
            path.basename(to),
            "partial",
            (yield* Random.nextInt).toString(36),
          ),
        );
        yield* sql`UPDATE moving SET partial = ${partial}
          WHERE from_path = ${from}`.pipe(Effect.orDie);
        let renamed = false;
        const undo = Effect.suspend(() =>
          wipe(partial).pipe(
            Effect.andThen(renamed ? wipe(to) : Effect.void),
            Effect.andThen(
              git.run(project.path, ["worktree", "repair", "--", from]),
            ),
          ),
        ).pipe(Effect.ignore);
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
        const repaired = yield* fs.rename(partial, to).pipe(
          Effect.orDie,
          Effect.tap(() =>
            Effect.sync(() => {
              renamed = true;
            }),
          ),
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
      // The same folder however it is spelled (a linked data dir, a
      // linked custom base) is already where it is asked to go.
      if (
        to === worktree.path ||
        (yield* fs.realPath(to).pipe(
          Effect.map((real) => real === worktree.path),
          Effect.orElseSucceed(() => false),
        ))
      ) {
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
      // with nothing under way. One that lands in the copy across volumes
      // undoes it, and the record goes with it.
      let crossed = false;
      const carried = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* claimMove(project, worktree.path, to);
          underWay.add(worktree.path);
          const link = yield* linkOf(worktree.path);
          return yield* Effect.gen(function* () {
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
              // git renames the checkout before it writes its own records,
              // so a failure can come after the move: the record stays,
              // for git's link to be repaired and the carry made.
              if (!crossed && (yield* movedOnDisk(worktree.path, to, link))) {
                if (!(yield* relinked(project, to)))
                  return yield* moved.failure;
              } else {
                yield* forgetRecord(worktree.path);
                // The folders made for it go again when they are ours and
                // empty.
                yield* pruneEmptyParents(to, project.path);
                return yield* moved.failure;
              }
            }
            const landed = yield* carry(project, worktree.path, to);
            // The original a copy across volumes leaves, once git lists the
            // copy: a stray folder, not a failed move.
            if (crossed) yield* wipe(worktree.path).pipe(Effect.ignore);
            // A capture's ref that couldn't follow keeps the record, for the
            // next start to carry it.
            if (landed.captured) yield* forgetRecord(worktree.path);
            return landed.row;
          }).pipe(
            Effect.onInterrupt(() => forgetRecord(worktree.path)),
            Effect.ensuring(Effect.sync(() => underWay.delete(worktree.path))),
          );
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

    // What a move carries once git lists the checkout at `toPath`: what
    // is kept under the old id re-keyed and the move recorded as made, in
    // one transaction, then the capture's ref and the lease. Each step
    // finds its work done when it runs again, so a resume repeats them
    // all; `captured` says whether the ref followed.
    const carry = (
      project: RegisteredProject,
      fromPath: string,
      toPath: string,
      rekeyed = false,
    ) =>
      Effect.gen(function* () {
        const moved = yield* findMoved(project, toPath);
        const from = worktreeIdFromPath(fromPath);
        let captured = true;
        if (moved.id !== from) {
          // Once only: a folder made at the old path since owns what is
          // under the old id by then.
          if (!rekeyed) {
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
                  sql`UPDATE moving SET carried = 1
                    WHERE from_path = ${fromPath}`,
                ]),
              )
              .pipe(Effect.orDie);
          }
          captured =
            (yield* kept.rekeyCapture(project, from, moved.id)) === "followed";
          yield* carryLease(fromPath, moved);
        }
        return { row: yield* row({ project, worktree: moved }), captured };
      });

    const carryMoved = Effect.fn("Worktrees.carryMoved")(function* (
      project: RegisteredProject,
      fromPath: string,
      toPath: string,
    ) {
      return (yield* carry(project, fromPath, toPath)).row;
    });

    // One recorded move whose process is gone, taken over by this one
    // alone. It landed when git lists its own checkout (the link it
    // recorded) at the destination and no longer at the source: it is
    // finished (the carry from where it stopped, then the original a copy
    // left). Still listed at the source, it is undone (the partial copy,
    // or the whole one a crash left before git was pointed at it). A
    // folder is deleted only when it is the move's own: the partial
    // sibling it named, or one holding its link.
    const resumeOne = (record: MovingRow) =>
      Effect.gen(function* () {
        if (yield* live(record)) return;
        if (!(yield* takeOver(record))) return;
        underWay.add(record.from_path);
        yield* Effect.gen(function* () {
          const project = (yield* registry.listed).find(
            ({ id }) => id === record.project_id,
          );
          if (project === undefined) {
            return yield* forgetRecord(record.from_path);
          }
          if (record.partial !== null) {
            yield* wipe(record.partial).pipe(Effect.ignore);
          }
          // git renamed it but couldn't record it: pointed at it now.
          if (
            (yield* listedAt(project, record.to_path)) === undefined &&
            (yield* movedOnDisk(
              record.from_path,
              record.to_path,
              record.link,
            )) &&
            !(yield* relinked(project, record.to_path))
          ) {
            // Still can't: kept for the next try.
            return;
          }
          // Its own checkout, not one git put at the path since.
          const atSource =
            (yield* listedAt(project, record.from_path)) !== undefined &&
            (record.link === "" ||
              (yield* holdsLink(record.from_path, record.link)));
          const landed =
            !atSource &&
            (yield* listedAt(project, record.to_path)) !== undefined &&
            (record.link === "" ||
              (yield* holdsLink(record.to_path, record.link)));
          if (landed) {
            const carried = yield* carry(
              project,
              record.from_path,
              record.to_path,
              record.carried === 1,
            );
            if (
              record.partial !== null &&
              (yield* holdsLink(record.from_path, record.link))
            ) {
              yield* wipe(record.from_path).pipe(Effect.ignore);
            }
            yield* pruneEmptyParents(record.from_path, project.path);
            if (carried.captured) yield* forgetRecord(record.from_path);
            return;
          }
          if (
            atSource &&
            record.partial !== null &&
            (yield* listedAt(project, record.to_path)) === undefined &&
            ((yield* holdsLink(record.to_path, record.link)) ||
              (yield* sameGitFile(record.to_path, record.from_path)))
          ) {
            yield* wipe(record.to_path).pipe(Effect.ignore);
          }
          yield* pruneEmptyParents(record.to_path, project.path);
          yield* forgetRecord(record.from_path);
        }).pipe(
          Effect.ensuring(Effect.sync(() => underWay.delete(record.from_path))),
        );
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
        SELECT * FROM moving`.pipe(Effect.orDie);
      for (const record of records) yield* resumeOne(record);
    }).pipe(Effect.withSpan("Worktrees.resumeMoves"));

    const interrupted = sql<MovingRow>`
      SELECT * FROM moving`.pipe(
      Effect.flatMap((records) =>
        Effect.filter(records, (record) =>
          Effect.map(live(record), (holds) => !holds),
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
      options: {
        readonly expect?: string | null;
        readonly back?: boolean;
      } = {},
    ) {
      const to = worktreeIdFromPath(cleanPath(toPath));
      if (to !== from) yield* kept.rekey(project, from, to, options);
      return to;
    });
    return { move, carryMoved, rename, rekey, resume, interrupted };
  });

export type MovingArea = Effect.Success<ReturnType<typeof makeMoving>>;
