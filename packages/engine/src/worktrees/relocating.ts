// Worktrees' relocating: a project moved or renamed by hand, pointed at
// where it is now, its worktrees re-linked.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Git from "../Git.ts";
import type { WorktreeEntry } from "../gitParse.ts";
import * as Layout from "../Layout.ts";
import * as Paths from "../Paths.ts";
import * as Terrier from "../Terrier.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import {
  cleanPath,
  isManagedPath,
  worktreeIdFromPath,
} from "../worktreeLayout.ts";
import {
  CaptureNotCarried,
  RelocateRefused,
  type WorktreeIdentity,
} from "./documents.ts";
import type { ListingArea } from "./listing.ts";
import type { KeptArea, Moved } from "./kept.ts";
import type { MovingArea } from "./moving.ts";

export const makeRelocating = ({
  listing,
  kept,
  moving,
}: {
  readonly listing: ListingArea;
  readonly kept: KeptArea;
  readonly moving: MovingArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const sql = yield* SqlClient.SqlClient;
    const layout = yield* Layout.Layout;
    const registry = yield* Registry.Registry;
    const terrier = yield* Terrier.Terrier;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const binary = paths.binaryName;
    const { identities } = listing;
    const { move } = moving;

    // The linked worktrees that moved along with the repo: git lists them
    // at a path that is gone, and they sit at the same place relative to
    // the repo's new path; or, once a repair ran (a relocate a crash cut
    // short, asked again), git lists them there already and the old place
    // is gone. Inside the repo, or beside it when a parent folder moved
    // whole, each ancestor pair that still shares a name tried, nearest
    // first. Old path to new. A pair whose old id kept nothing re-keys
    // nothing.
    const movedAlong = (repo: string, oldPath: string) =>
      Effect.gen(function* () {
        const moved = new Map<string, string>();
        const entries = yield* git
          .listWorktrees(repo)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<WorktreeEntry> => []));
        const pairs: Array<readonly [string, string]> = [[oldPath, repo]];
        for (
          let from = oldPath, to = repo;
          path.basename(from) === path.basename(to);
        ) {
          from = path.dirname(from);
          to = path.dirname(to);
          if (from === to || from === path.dirname(from)) break;
          pairs.push([from, to]);
        }
        const exists = (at: string) =>
          fs.exists(at).pipe(Effect.orElseSucceed(() => true));
        for (const entry of entries) {
          if (yield* exists(entry.path)) {
            for (const [from, to] of pairs) {
              if (!entry.path.startsWith(`${to}/`)) continue;
              const before = path.join(from, entry.path.slice(to.length + 1));
              if (!(yield* exists(before))) {
                moved.set(before, entry.path);
                break;
              }
            }
            continue;
          }
          for (const [from, to] of pairs) {
            if (!entry.path.startsWith(`${from}/`)) continue;
            const candidate = path.join(to, entry.path.slice(from.length + 1));
            const isDirectory = yield* fs.stat(candidate).pipe(
              Effect.map((info) => info.type === "Directory"),
              Effect.orElseSucceed(() => false),
            );
            if (isDirectory) {
              moved.set(entry.path, candidate);
              break;
            }
          }
        }
        return moved;
      });

    // `git worktree repair` for the moved ones (old path to new), and the
    // ids what each kept moves between, from its old id to the one git
    // lists it under now. git repairs each path on its own, so the ones
    // it did re-link count whatever it answers, and `repaired` says it.
    const rekeysOf = (
      project: RegisteredProject,
      moved: ReadonlyMap<string, string>,
    ) =>
      Effect.gen(function* () {
        const repaired = yield* git
          .run(project.path, ["worktree", "repair", "--", ...moved.values()])
          .pipe(Effect.result);
        const found = yield* identities(project).pipe(
          Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []),
        );
        const rekeys: Array<{
          readonly from: string;
          readonly to: string;
          readonly where: Moved;
        }> = [];
        for (const [oldPath, newPath] of moved) {
          const resolved = yield* fs
            .realPath(newPath)
            .pipe(Effect.orElseSucceed(() => ""));
          const now = found.find(
            (id) =>
              id.path === newPath || (resolved !== "" && id.path === resolved),
          );
          if (now === undefined) continue;
          const from = worktreeIdFromPath(oldPath);
          if (from !== now.id) {
            rekeys.push({
              from,
              to: now.id,
              where: { fromPath: oldPath, toPath: now.path },
            });
          }
        }
        return { rekeys, repaired };
      });

    // Worktrees moved by hand re-linked, what each kept carried to its id
    // there, and git's repair failure said after.
    const relink = Effect.fn("Worktrees.relink")(function* (
      project: RegisteredProject,
      moved: ReadonlyMap<string, string>,
    ) {
      const { rekeys, repaired } = yield* rekeysOf(project, moved);
      for (const { from, to, where } of rekeys) {
        yield* kept.rekey(project, from, to, { moved: where });
      }
      if (Result.isFailure(repaired)) return yield* repaired.failure;
    });

    // The managed bases are named after the repo's folder, so a rename
    // would leave the managed worktrees reading as external. Each moves to
    // where new worktrees go.
    const rehomeManaged = (project: RegisteredProject, oldPath: string) =>
      Effect.gen(function* () {
        const oldBases = yield* layout.managedBases({
          ...project,
          path: oldPath,
        });
        const newBases = yield* layout.managedBases(project);
        const base = yield* layout.worktreeBase(project);
        const found = yield* identities(project).pipe(
          Effect.orElseSucceed((): ReadonlyArray<WorktreeIdentity> => []),
        );
        for (const worktree of found) {
          if (
            worktree.isPrimary ||
            !isManagedPath(worktree.path, oldBases) ||
            isManagedPath(worktree.path, newBases) ||
            !(yield* fs
              .exists(worktree.path)
              .pipe(Effect.orElseSucceed(() => false)))
          ) {
            continue;
          }
          yield* move(
            { project, worktree },
            path.join(base, path.basename(worktree.path)),
          ).pipe(Effect.ignore);
        }
      });

    const relocateProject = Effect.fn("Worktrees.relocateProject")(function* (
      project: Registry.ListedProject,
      target: string,
    ) {
      const refuse = (reason: RelocateRefused["reason"], at: string) =>
        new RelocateRefused({ reason, path: at, name: project.name, binary });
      if (project.source === "terrier") {
        return yield* refuse("via-terrier", project.path);
      }
      // Folded to the primary checkout, so a folder inside the repo or one
      // of its worktrees still lands on the repo.
      const repo = yield* git.locate(target);
      if (Option.isNone(repo)) return yield* refuse("not-a-repo", target);
      const to = repo.value.primaryPath;
      if (to !== project.path) {
        // Only for a repo that went: pointing a project that is still there
        // at another repo would hand that repo its settings and marks.
        const stillThere = yield* fs.stat(project.path).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (stillThere) return yield* refuse("still-there", project.path);
        // terrier's rows merge in by path, so either side being one would
        // list one repo twice.
        const { paths: listed } = yield* terrier.listing;
        if (listed.includes(project.path)) {
          return yield* refuse("terrier-lists-old", project.path);
        }
        if (listed.includes(to)) return yield* refuse("terrier-lists-new", to);
        const moved = yield* movedAlong(to, project.path);
        moved.set(project.path, to);
        const { rekeys } = yield* rekeysOf(
          { id: project.id, name: path.basename(to), path: to },
          moved,
        );
        // The new path and what is kept under the moved ids commit
        // together, so a crash leaves the project where it was, or where it
        // went with all it kept.
        const relocated = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const entry = yield* registry.relocate(
                project.id,
                to,
                path.basename(to),
              );
              for (const { from, to: now, where } of rekeys) {
                yield* kept.rekeyRows(entry, from, now, where);
              }
              return entry;
            }),
          )
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
        // Best effort from here: the entry already points at the new path.
        // A capture that didn't follow is said, and stays under the old id.
        for (const { from, to: now } of rekeys) {
          const carried = yield* kept.rekeyCapture(relocated, from, now);
          if (carried !== "followed") {
            yield* Effect.logWarning(
              new CaptureNotCarried({ from, to: now, reason: carried }).message,
            );
          }
        }
        yield* rehomeManaged(relocated, project.path);
      }
      const rows = yield* registry.rows();
      const found = rows.find((listed) => listed.id === project.id);
      if (!found)
        return yield* new Registry.UnknownProject({ projectId: project.id });
      return found;
    });

    // Where each of the project's managed worktrees would go under
    // `proposed` layout settings, and whether it is there already: the
    // same folder, however its path is spelled (a linked data dir or
    // custom base), counts.
    const relocationPlan = Effect.fn("Worktrees.relocationPlan")(function* (
      project: RegisteredProject,
      proposed: {
        readonly worktreeLayout?: string | undefined;
        readonly customWorktreePath?: string | undefined;
      },
    ) {
      const [base, bases, found] = yield* Effect.all(
        [
          layout.baseFor(project, proposed),
          layout.managedBases(project),
          identities(project),
        ],
        { concurrency: "unbounded" },
      );
      return yield* Effect.forEach(
        found.filter(
          (worktree) =>
            !worktree.isPrimary && isManagedPath(worktree.path, bases),
        ),
        (worktree) =>
          Effect.gen(function* () {
            const destination = cleanPath(path.join(base, worktree.name));
            const inPlace =
              destination === worktree.path ||
              (yield* fs.realPath(destination).pipe(
                Effect.map((real) => real === worktree.path),
                Effect.orElseSucceed(() => false),
              ));
            return { worktreeId: worktree.id, destination, inPlace };
          }),
      );
    });

    return { relocateProject, relocationPlan, relink };
  });
